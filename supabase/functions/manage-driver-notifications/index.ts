import { createClient } from 'npm:@supabase/supabase-js@2';

type RequestBody = {
  action?: 'delete';
  notificationId?: string;
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
    const action = body?.action;
    const notificationId = body?.notificationId?.trim();

    if (action !== 'delete' || !notificationId) {
      return jsonResponse(400, { error: 'action=delete and notificationId are required' });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const { error: deleteError } = await supabaseAdmin
      .from('notifications')
      .delete()
      .eq('id', notificationId)
      .eq('recipient_id', user.id)
      .eq('recipient_role', 'driver');

    if (deleteError) {
      console.log('[manage-driver-notifications] delete failed', {
        notificationId,
        driverId: user.id,
        deleteError,
      });
      return jsonResponse(500, { error: 'Unable to delete notification' });
    }

    return jsonResponse(200, {
      success: true,
      action,
      notificationId,
    });
  } catch (error) {
    console.log('[manage-driver-notifications] unexpected error', error);
    return jsonResponse(500, { error: 'Unexpected notification management error' });
  }
});