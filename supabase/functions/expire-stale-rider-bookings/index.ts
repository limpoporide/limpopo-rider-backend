import { createClient } from 'npm:@supabase/supabase-js@2';

const jsonResponse = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

type ExpireStaleRiderBookingsResponse = {
  booking_id: string;
};

const CANONICAL_BOOKING_EXPIRY_MINUTES = 2;

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return jsonResponse(500, { error: 'Server is misconfigured' });
    }

    const body = await req.json().catch(() => ({}));
    const requestedExpiryMinutes = typeof body?.expiryMinutes === 'number'
      ? body.expiryMinutes
      : CANONICAL_BOOKING_EXPIRY_MINUTES;
    const expiryMinutes = Number.isFinite(requestedExpiryMinutes)
      ? Math.min(60, Math.max(1, requestedExpiryMinutes))
      : CANONICAL_BOOKING_EXPIRY_MINUTES;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
    const { data, error } = await supabaseAdmin.rpc('expire_stale_open_rider_bookings', {
      p_expiry: `${expiryMinutes} minutes`,
    });

    if (error) {
      console.log('[expire-stale-rider-bookings] expiry failed', error);
      return jsonResponse(500, { error: 'Unable to expire stale rider bookings' });
    }

    const expiredBookings = Array.isArray(data)
      ? (data as ExpireStaleRiderBookingsResponse[])
      : [];

    return jsonResponse(200, {
      expiredCount: expiredBookings.length,
      bookingIds: expiredBookings.map((booking) => booking.booking_id),
    });
  } catch (error) {
    console.log('[expire-stale-rider-bookings] unexpected error', error);
    return jsonResponse(500, { error: 'Unexpected server error' });
  }
});