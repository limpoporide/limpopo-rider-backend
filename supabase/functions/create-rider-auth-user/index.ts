import { createClient } from 'npm:@supabase/supabase-js@2';

type CreateRiderAuthUserRequest = {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  password?: string;
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
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return jsonResponse(500, { error: 'Server is misconfigured' });
    }

    const body = (await req.json().catch(() => null)) as CreateRiderAuthUserRequest | null;
    const firstName = body?.firstName?.trim() ?? '';
    const lastName = body?.lastName?.trim() ?? '';
    const email = body?.email?.trim().toLowerCase() ?? '';
    const phone = body?.phone?.trim() ?? '';
    const password = body?.password?.trim() ?? '';
    const normalizedPhone = normalizePhoneNumber(phone);

    if (firstName.length < 3) {
      return jsonResponse(400, { error: 'First name must be at least 3 characters' });
    }

    if (lastName.length < 3) {
      return jsonResponse(400, { error: 'Last name must be at least 3 characters' });
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse(400, { error: 'A valid email is required' });
    }

    if (!normalizedPhone) {
      return jsonResponse(400, { error: 'A valid phone number is required' });
    }

    if (!/^\d{6}$/.test(password)) {
      return jsonResponse(400, { error: 'Password must be exactly 6 digits' });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const { data: createdUser, error: createUserError } = await supabaseAdmin.auth.admin.createUser({
      email,
      phone: normalizedPhone,
      password,
      email_confirm: true,
      phone_confirm: true,
      user_metadata: {
        email,
        first_name: firstName,
        last_name: lastName,
        phone_num: phone,
        phone_verified: true,
      },
    });

    if (createUserError || !createdUser.user) {
      console.log('[create-rider-auth-user] failed to create auth user', createUserError);
      return jsonResponse(400, { error: createUserError?.message ?? 'Unable to create rider auth user' });
    }

    const riderUserId = createdUser.user.id;

    const { error: profileError } = await supabaseAdmin.from('rider_profile').upsert(
      {
        uuid: riderUserId,
        first_name: firstName,
        last_name: lastName,
        email,
        phone_num: phone,
        phone_verified: true,
        wallet_balance: 0,
        push_notification: true,
      },
      { onConflict: 'uuid' }
    );

    if (profileError) {
      console.log('[create-rider-auth-user] failed to create rider profile', profileError);

      const { error: rollbackError } = await supabaseAdmin.auth.admin.deleteUser(riderUserId);

      if (rollbackError) {
        console.log('[create-rider-auth-user] failed to rollback auth user after profile error', rollbackError);
      }

      return jsonResponse(500, { error: profileError.message || 'Unable to create rider profile' });
    }

    return jsonResponse(200, {
      success: true,
      userId: riderUserId,
    });
  } catch (error) {
    console.log('[create-rider-auth-user] unexpected error', error);
    return jsonResponse(500, { error: 'Unexpected rider account creation error' });
  }
});