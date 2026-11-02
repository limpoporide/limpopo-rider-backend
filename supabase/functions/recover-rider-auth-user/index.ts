import { createClient } from 'npm:@supabase/supabase-js@2';

type RecoveryProfileSnapshot = {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone_num?: string;
  phone_verified?: boolean;
  profile_img?: string | null;
  city?: string | null;
  state?: string | null;
  wallet_account?: string | null;
  wallet_balance?: number | string | null;
  account_name?: string | null;
  bank_name?: string | null;
  budpay_customer_code?: string | null;
  location_lat?: number | null;
  location_lng?: number | null;
  expo_push_token?: string | null;
  push_token_updated_at?: string | null;
  push_notification?: boolean;
  visibility?: boolean;
  created_at?: string;
  updated_at?: string;
};

type RecoveryRequest = {
  oldUuid?: string;
  temporaryPassword?: string;
  profileSnapshot?: RecoveryProfileSnapshot;
};

const jsonResponse = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const normalizePhoneNumber = (value: string | undefined) => {
  const digitsOnly = (value ?? '').replace(/\D/g, '');

  if (digitsOnly.length === 11 && digitsOnly.startsWith('0')) {
    return `+234${digitsOnly.slice(1)}`;
  }

  if (digitsOnly.length === 10) {
    return `+234${digitsOnly}`;
  }

  if (digitsOnly.length === 13 && digitsOnly.startsWith('234')) {
    return `+${digitsOnly}`;
  }

  if ((value ?? '').startsWith('+') && digitsOnly.length >= 10) {
    return `+${digitsOnly}`;
  }

  return null;
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
      data: { user: callerUser },
      error: callerError,
    } = await callerClient.auth.getUser();

    if (callerError || !callerUser) {
      return jsonResponse(401, { error: 'Invalid or expired session' });
    }

    const body = (await req.json().catch(() => null)) as RecoveryRequest | null;
    const oldUuid = body?.oldUuid?.trim();
    const temporaryPassword = body?.temporaryPassword?.trim();
    const snapshot = body?.profileSnapshot ?? {};

    if (!oldUuid) {
      return jsonResponse(400, { error: 'oldUuid is required' });
    }

    if (!temporaryPassword || !/^\d{6}$/.test(temporaryPassword)) {
      return jsonResponse(400, { error: 'temporaryPassword must be exactly 6 digits' });
    }

    const email = snapshot.email?.trim().toLowerCase();
    const normalizedPhone = normalizePhoneNumber(snapshot.phone_num);

    if (!email) {
      return jsonResponse(400, { error: 'profileSnapshot.email is required' });
    }

    if (!normalizedPhone) {
      return jsonResponse(400, { error: 'profileSnapshot.phone_num must be a valid phone number' });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const { data: adminProfile, error: adminError } = await supabaseAdmin
      .from('admin_profile')
      .select('role, is_active')
      .eq('uuid', callerUser.id)
      .maybeSingle();

    if (adminError) {
      console.log('[recover-rider-auth-user] failed to load admin profile', adminError);
      return jsonResponse(500, { error: 'Unable to verify admin access' });
    }

    if (!adminProfile?.is_active || adminProfile.role !== 'super-admin') {
      return jsonResponse(403, { error: 'Only active super-admins can recover rider auth users' });
    }

    const { data: createdUser, error: createUserError } = await supabaseAdmin.auth.admin.createUser({
      email,
      phone: normalizedPhone,
      password: temporaryPassword,
      email_confirm: true,
      phone_confirm: snapshot.phone_verified ?? true,
      user_metadata: {
        first_name: snapshot.first_name?.trim() ?? '',
        last_name: snapshot.last_name?.trim() ?? '',
        phone_num: snapshot.phone_num?.trim() ?? normalizedPhone,
        phone_verified: snapshot.phone_verified ?? true,
      },
    });

    if (createUserError || !createdUser.user) {
      console.log('[recover-rider-auth-user] failed to create replacement auth user', createUserError);
      return jsonResponse(400, { error: createUserError?.message ?? 'Unable to create replacement auth user' });
    }

    const replacementUserId = createdUser.user.id;

    const recoveryPayload = {
      ...snapshot,
      email,
      phone_num: snapshot.phone_num?.trim() ?? normalizedPhone,
      phone_verified: snapshot.phone_verified ?? true,
      updated_at: snapshot.updated_at ?? new Date().toISOString(),
    };

    const { data: migrationResult, error: migrationError } = await supabaseAdmin.rpc('admin_recover_rider_account', {
      p_old_uuid: oldUuid,
      p_new_uuid: replacementUserId,
      p_profile: recoveryPayload,
    });

    if (migrationError) {
      console.log('[recover-rider-auth-user] rider data migration failed', migrationError);

      const { error: rollbackError } = await supabaseAdmin.auth.admin.deleteUser(replacementUserId);

      if (rollbackError) {
        console.log('[recover-rider-auth-user] failed to delete replacement auth user after migration error', rollbackError);
      }

      return jsonResponse(500, { error: migrationError.message || 'Unable to migrate rider data to replacement auth user' });
    }

    return jsonResponse(200, {
      success: true,
      oldUuid,
      newUuid: replacementUserId,
      migrated: migrationResult,
      nextStep: 'The rider can now log in with the temporary 6-digit password and should change it immediately in the app.',
    });
  } catch (error) {
    console.log('[recover-rider-auth-user] unexpected error', error);
    return jsonResponse(500, { error: 'Unexpected rider auth recovery error' });
  }
});