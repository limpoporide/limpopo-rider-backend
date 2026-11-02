import { createClient } from 'npm:@supabase/supabase-js@2';

type RequestBody = {
  bookingId?: string;
  viewerLabel?: string;
  createdFrom?: string;
};

const ACTIVE_SHARE_HOURS = 12;
const COMPLETED_SHARE_HOURS = 1;
const SHAREABLE_RIDE_STATUSES = new Set(['accepted', 'arrived', 'in_progress', 'completed']);

const jsonResponse = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });

const sha256Hex = async (value: string) => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

const createShareToken = async () => {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const randomHex = Array.from(randomBytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  return `${crypto.randomUUID()}${randomHex}`;
};

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
    const bookingId = body?.bookingId?.trim() ?? '';
    const viewerLabel = body?.viewerLabel?.trim() || null;
    const createdFrom = body?.createdFrom?.trim() || 'rider_accept_screen';

    if (!bookingId) {
      return jsonResponse(400, { error: 'bookingId is required' });
    }

    const { data: booking, error: bookingError } = await callerClient
      .from('rider_booking')
      .select('id, rider_id, assigned_driver, ride_status')
      .eq('id', bookingId)
      .maybeSingle();

    if (bookingError) {
      console.log('[create-trip-share-link] booking lookup failed', { bookingId, bookingError });
      return jsonResponse(500, { error: 'Unable to load booking' });
    }

    if (!booking || booking.rider_id !== user.id) {
      return jsonResponse(404, { error: 'Booking not found' });
    }

    if (!SHAREABLE_RIDE_STATUSES.has(booking.ride_status)) {
      return jsonResponse(400, { error: 'This trip is not currently shareable' });
    }

    if (!booking.assigned_driver) {
      return jsonResponse(400, { error: 'A live trip link becomes available after a pilot is assigned' });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
    const now = Date.now();
    const expiresAt = new Date(
      now + (booking.ride_status === 'completed' ? COMPLETED_SHARE_HOURS : ACTIVE_SHARE_HOURS) * 60 * 60 * 1000
    ).toISOString();
    const shareToken = await createShareToken();
    const shareTokenHash = await sha256Hex(shareToken);

    const { error: revokeError } = await supabaseAdmin
      .from('trip_share_session')
      .update({ share_status: 'revoked' })
      .eq('booking_id', bookingId)
      .eq('rider_id', user.id)
      .eq('share_status', 'active');

    if (revokeError) {
      console.log('[create-trip-share-link] revoke failed', { bookingId, riderId: user.id, revokeError });
      return jsonResponse(500, { error: 'Unable to reset previous share links' });
    }

    const { data: session, error: insertError } = await supabaseAdmin
      .from('trip_share_session')
      .insert({
        booking_id: bookingId,
        rider_id: user.id,
        share_token_hash: shareTokenHash,
        share_status: 'active',
        expires_at: expiresAt,
        viewer_label: viewerLabel,
        created_from: createdFrom,
      })
      .select('id, share_status, expires_at')
      .maybeSingle();

    if (insertError) {
      console.log('[create-trip-share-link] insert failed', { bookingId, riderId: user.id, insertError });
      return jsonResponse(500, { error: 'Unable to create share link' });
    }

    const shareUrl = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/trip-share?token=${encodeURIComponent(shareToken)}`;

    return jsonResponse(200, {
      shareUrl,
      sessionId: session?.id ?? null,
      shareStatus: session?.share_status ?? 'active',
      expiresAt: session?.expires_at ?? expiresAt,
    });
  } catch (error) {
    console.log('[create-trip-share-link] unexpected error', error);
    return jsonResponse(500, { error: 'Unexpected trip share error' });
  }
});