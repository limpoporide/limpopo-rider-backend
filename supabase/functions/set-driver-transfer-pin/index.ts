// Supabase Edge Function: set-driver-transfer-pin
// Hashes the PIN server-side (via the set_driver_transfer_pin RPC, pgcrypto
// bcrypt) so the raw PIN is never stored — only the hash lives in driver_profile.
import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const authHeader = req.headers.get('Authorization');

    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), { status: 401 });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      return new Response(JSON.stringify({ error: 'Server is misconfigured' }), { status: 500 });
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

    const body = await req.json().catch(() => null);
    const pin = body?.pin as string | undefined;

    if (!pin || !/^\d{4,6}$/.test(pin)) {
      return new Response(JSON.stringify({ error: 'PIN must be 4 to 6 digits' }), { status: 400 });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const { error: rpcError } = await supabaseAdmin.rpc('set_driver_transfer_pin', {
      p_driver_uuid: user.id,
      p_pin: pin,
    });

    if (rpcError) {
      console.log('Unable to set driver transfer PIN:', rpcError);
      return new Response(JSON.stringify({ error: 'Unable to set transfer PIN' }), { status: 500 });
    }

    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.log('set-driver-transfer-pin error:', error);
    return new Response(JSON.stringify({ error: 'Unexpected error setting transfer PIN' }), { status: 500 });
  }
});
