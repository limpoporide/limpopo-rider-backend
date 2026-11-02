import { createClient } from 'npm:@supabase/supabase-js@2';

const jsonResponse = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

type PromoteScheduledBookingsResponse = {
  schedule_booking_id: string;
  rider_booking_id: string;
  rider_id: string;
  created_status: string;
  assigned_driver: string | null;
};

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
    const requestedLeadTimeHours = typeof body?.leadTimeHours === 'number' ? body.leadTimeHours : 2;
    const leadTimeHours = Number.isFinite(requestedLeadTimeHours)
      ? Math.min(24, Math.max(1, requestedLeadTimeHours))
      : 2;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
    const { data, error } = await supabaseAdmin.rpc('promote_due_scheduled_bookings', {
      p_lead_time: `${leadTimeHours} hours`,
    });

    if (error) {
      console.log('[promote-scheduled-bookings] promotion failed', error);
      return jsonResponse(500, { error: 'Unable to promote scheduled bookings' });
    }

    const promotions = Array.isArray(data)
      ? (data as PromoteScheduledBookingsResponse[])
      : [];

    return jsonResponse(200, {
      promotedCount: promotions.length,
      promotions,
    });
  } catch (error) {
    console.log('[promote-scheduled-bookings] unexpected error', error);
    return jsonResponse(500, { error: 'Unexpected server error' });
  }
});