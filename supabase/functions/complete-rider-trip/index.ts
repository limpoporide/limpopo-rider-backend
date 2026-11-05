import { createClient } from 'npm:@supabase/supabase-js@2';

type RequestBody = {
  bookingId?: string;
  reason?: string;
};

const jsonResponse = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    const authHeader = req.headers.get('Authorization');

    if (!authHeader) {
      return jsonResponse(401, { error: 'Missing authorization header' });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      return jsonResponse(500, { error: 'Server is misconfigured' });
    }

    const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: userError,
    } = await callerClient.auth.getUser();

    if (userError || !user) {
      return jsonResponse(401, { error: 'Invalid or expired session' });
    }

    const body = (await req.json().catch(() => null)) as RequestBody | null;
    const bookingId = body?.bookingId?.trim();
    const reason = body?.reason?.trim() ?? null;

    if (!bookingId) {
      return jsonResponse(400, { error: 'bookingId is required' });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
    const { data: booking, error: bookingError } = await supabaseAdmin
      .from('rider_booking')
      .select('id, assigned_driver, ride_status, trip_completed_at')
      .eq('id', bookingId)
      .maybeSingle();

    if (bookingError) {
      console.log('[complete-rider-trip] failed to load booking', {
        bookingId,
        driverId: user.id,
        bookingError,
      });
      return jsonResponse(500, { error: 'Unable to load booking details' });
    }

    if (!booking) {
      return jsonResponse(404, { error: 'Booking not found' });
    }

    if (booking.assigned_driver !== user.id) {
      return jsonResponse(403, { error: 'You are not assigned to this booking' });
    }

    if (booking.ride_status === 'completed') {
      return jsonResponse(200, {
        success: true,
        status: 'already_completed',
        rideStatus: booking.ride_status,
        tripCompletedAt: booking.trip_completed_at,
        reason,
      });
    }

    if (booking.ride_status !== 'in_progress') {
      return jsonResponse(409, { error: 'Trip must be in progress before it can be completed' });
    }

    const completedAt = new Date().toISOString();
    const { data: updatedBooking, error: updateError } = await supabaseAdmin
      .from('rider_booking')
      .update({
        ride_status: 'completed',
        trip_completed_at: completedAt,
      })
      .eq('id', bookingId)
      .eq('assigned_driver', user.id)
      .eq('ride_status', 'in_progress')
      .select('id, ride_status, trip_completed_at')
      .maybeSingle();

    if (updateError) {
      console.log('[complete-rider-trip] failed to update booking', {
        bookingId,
        driverId: user.id,
        reason,
        updateError,
      });
      return jsonResponse(500, { error: 'Unable to complete trip' });
    }

    if (!updatedBooking) {
      const { data: currentBooking, error: currentBookingError } = await supabaseAdmin
        .from('rider_booking')
        .select('ride_status, trip_completed_at')
        .eq('id', bookingId)
        .maybeSingle();

      if (currentBookingError) {
        console.log('[complete-rider-trip] failed to reload booking after update miss', {
          bookingId,
          driverId: user.id,
          reason,
          currentBookingError,
        });
        return jsonResponse(500, { error: 'Unable to confirm trip completion' });
      }

      if (currentBooking?.ride_status === 'completed') {
        return jsonResponse(200, {
          success: true,
          status: 'already_completed',
          rideStatus: currentBooking.ride_status,
          tripCompletedAt: currentBooking.trip_completed_at,
          reason,
        });
      }

      return jsonResponse(409, { error: 'Trip could not be completed from its current state' });
    }

    return jsonResponse(200, {
      success: true,
      status: 'completed',
      rideStatus: updatedBooking.ride_status,
      tripCompletedAt: updatedBooking.trip_completed_at,
      reason,
    });
  } catch (error) {
    console.log('[complete-rider-trip] unexpected error', error);
    return jsonResponse(500, { error: 'Unexpected trip completion error' });
  }
});