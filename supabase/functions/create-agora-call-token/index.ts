import AgoraToken from 'npm:agora-token@2.0.6';
import { createClient } from 'npm:@supabase/supabase-js@2';

const { RtcRole, RtcTokenBuilder } = AgoraToken as {
  RtcRole: { PUBLISHER: number };
  RtcTokenBuilder: {
    buildTokenWithUid: (
      appId: string,
      appCertificate: string,
      channelName: string,
      uid: number,
      role: number,
      privilegeExpiredTs: number
    ) => string;
  };
};

const hashUid = (value: string) => {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return Math.max(1, hash);
};

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const authHeader = req.headers.get('Authorization');

    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), { status: 401 });
    }

    const { bookingId } = await req.json().catch(() => ({ bookingId: '' }));
    const normalizedBookingId = typeof bookingId === 'string' ? bookingId.trim() : '';

    if (!normalizedBookingId) {
      return new Response(JSON.stringify({ error: 'bookingId is required' }), { status: 400 });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const agoraAppId = Deno.env.get('AGORA_APP_ID');
    const agoraAppCertificate = Deno.env.get('AGORA_APP_CERTIFICATE');

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      return new Response(JSON.stringify({ error: 'Server is misconfigured' }), { status: 500 });
    }

    if (!agoraAppId || !agoraAppCertificate) {
      return new Response(JSON.stringify({ error: 'Agora secrets are not configured on the server' }), { status: 500 });
    }

    const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: userError,
    } = await callerClient.auth.getUser();

    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid or expired session' }), { status: 401 });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
    const { data: booking, error: bookingError } = await supabaseAdmin
      .from('rider_booking')
      .select('id, rider_id, assigned_driver, ride_status')
      .eq('id', normalizedBookingId)
      .maybeSingle();

    if (bookingError || !booking) {
      return new Response(JSON.stringify({ error: 'Booking not found' }), { status: 404 });
    }

    const isParticipant = booking.rider_id === user.id || booking.assigned_driver === user.id;

    if (!isParticipant) {
      return new Response(JSON.stringify({ error: 'You are not allowed to join this call' }), { status: 403 });
    }

    if (!booking.assigned_driver) {
      return new Response(JSON.stringify({ error: 'A driver must be assigned before starting a call' }), { status: 409 });
    }

    const channelName = `ride-${normalizedBookingId}`.slice(0, 64);
    const uid = hashUid(user.id);
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
    const token = RtcTokenBuilder.buildTokenWithUid(
      agoraAppId,
      agoraAppCertificate,
      channelName,
      uid,
      RtcRole.PUBLISHER,
      expiresAt
    );

    return new Response(
      JSON.stringify({
        appId: agoraAppId,
        channelName,
        token,
        uid,
        expiresAt,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.log('create-agora-call-token error:', error);
    return new Response(JSON.stringify({ error: 'Unexpected error creating Agora call token' }), { status: 500 });
  }
});