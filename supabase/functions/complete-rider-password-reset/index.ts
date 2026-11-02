import { createClient } from 'npm:@supabase/supabase-js@2';

const TERMII_BASE_URL = 'https://v4.api.termii.com';
const OTP_LENGTH = 6;
const PASSWORD_LENGTH = 6;

type CompleteRiderPasswordResetRequest = {
  phone?: string;
  resetToken?: string;
  password?: string;
};

const encoder = new TextEncoder();

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

const toLocalPhoneNumber = (value: string) => {
  const digitsOnly = value.replace(/\D/g, '');

  if (digitsOnly.startsWith('234') && digitsOnly.length === 13) {
    return `0${digitsOnly.slice(3)}`;
  }

  if (digitsOnly.length === 10) {
    return `0${digitsOnly}`;
  }

  return digitsOnly.slice(0, 11);
};

const getResetSecret = () => Deno.env.get('PASSWORD_RESET_TOKEN_SECRET') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const encodeBase64Url = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const decodeBase64Url = (value: string) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return atob(padded);
};

const signPayload = async (payload: string, secret: string) => {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(payload));
  return encodeBase64Url(new Uint8Array(signature));
};

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const resetSecret = getResetSecret();

    if (!supabaseUrl || !supabaseServiceRoleKey || !resetSecret) {
      return jsonResponse(500, { error: 'Server is misconfigured' });
    }

    const body = (await req.json().catch(() => null)) as CompleteRiderPasswordResetRequest | null;
    const normalizedPhone = normalizePhoneNumber(body?.phone);
    const resetToken = body?.resetToken?.trim() ?? '';
    const password = body?.password?.trim() ?? '';

    if (!normalizedPhone) {
      return jsonResponse(400, { error: 'A valid phone number is required' });
    }

    if (!resetToken) {
      return jsonResponse(400, { error: 'A verified reset session is required' });
    }

    if (!/^\d{6}$/.test(password) || password.length !== PASSWORD_LENGTH) {
      return jsonResponse(400, { error: 'Create a 6-digit password to continue' });
    }

    const [encodedPayload, providedSignature] = resetToken.split('.');

    if (!encodedPayload || !providedSignature) {
      return jsonResponse(400, { error: 'Reset session is invalid or expired' });
    }

    const expectedSignature = await signPayload(encodedPayload, resetSecret);

    if (expectedSignature !== providedSignature) {
      return jsonResponse(401, { error: 'Reset session is invalid or expired' });
    }

    const decodedPayload = JSON.parse(decodeBase64Url(encodedPayload)) as {
      phone?: string;
      purpose?: string;
      exp?: number;
    };

    if (decodedPayload.purpose !== 'rider-password-reset' || decodedPayload.phone !== normalizedPhone || typeof decodedPayload.exp !== 'number' || decodedPayload.exp < Date.now()) {
      return jsonResponse(401, { error: 'Reset session is invalid or expired' });
    }

    const localPhone = toLocalPhoneNumber(normalizedPhone);
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('rider_profile')
      .select('uuid')
      .eq('phone_num', localPhone)
      .maybeSingle<{ uuid: string }>();

    if (profileError) {
      console.log('[complete-rider-password-reset] profile lookup failed', profileError);
      return jsonResponse(500, { error: 'Unable to reset password right now' });
    }

    if (!profile?.uuid) {
      return jsonResponse(404, { error: 'No rider account exists for this phone number' });
    }

    const { error: updateUserError } = await supabaseAdmin.auth.admin.updateUserById(profile.uuid, {
      password,
      phone_confirm: true,
      user_metadata: {
        phone_num: localPhone,
        phone_verified: true,
      },
    });

    if (updateUserError) {
      console.log('[complete-rider-password-reset] auth update failed', updateUserError);
      return jsonResponse(400, { error: updateUserError.message ?? 'Unable to update password' });
    }

    const { error: profileUpdateError } = await supabaseAdmin
      .from('rider_profile')
      .update({ phone_verified: true })
      .eq('uuid', profile.uuid);

    if (profileUpdateError) {
      console.log('[complete-rider-password-reset] profile update failed', profileUpdateError);
      return jsonResponse(500, { error: 'Password updated but profile sync failed' });
    }

    return jsonResponse(200, { success: true });
  } catch (error) {
    console.log('[complete-rider-password-reset] unexpected error', error);
    return jsonResponse(500, { error: 'Unexpected password reset completion error' });
  }
});