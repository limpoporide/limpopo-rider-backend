const TERMII_BASE_URL = 'https://v4.api.termii.com';
const OTP_LENGTH = 6;

type VerifyRiderPasswordResetOtpRequest = {
  phone?: string;
  pinId?: string;
  otp?: string;
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

const getResetSecret = () => Deno.env.get('PASSWORD_RESET_TOKEN_SECRET') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const encodeBase64Url = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

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
    const termiiApiKey = Deno.env.get('TERMII_API_KEY');
    const resetSecret = getResetSecret();

    if (!termiiApiKey || !resetSecret) {
      return jsonResponse(500, { error: 'Server is misconfigured' });
    }

    const body = (await req.json().catch(() => null)) as VerifyRiderPasswordResetOtpRequest | null;
    const normalizedPhone = normalizePhoneNumber(body?.phone);
    const pinId = body?.pinId?.trim() ?? '';
    const otp = body?.otp?.trim() ?? '';

    if (!normalizedPhone) {
      return jsonResponse(400, { error: 'A valid phone number is required' });
    }

    if (!pinId) {
      return jsonResponse(400, { error: 'A valid OTP session is required' });
    }

    if (!/^\d{6}$/.test(otp) || otp.length !== OTP_LENGTH) {
      return jsonResponse(400, { error: 'Enter the 6-digit OTP code' });
    }

    const response = await fetch(`${TERMII_BASE_URL}/api/sms/otp/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: termiiApiKey,
        pin_id: pinId,
        pin: otp,
      }),
    });

    const payload = await response.json().catch(() => null);
    const isVerified = String(payload?.verified).toLowerCase() === 'true';

    if (!response.ok || !isVerified) {
      console.log('[verify-rider-password-reset-otp] Termii verify failed', payload);
      return jsonResponse(response.ok ? 400 : response.status, {
        error: payload?.message ?? payload?.smsStatus ?? 'The OTP code is invalid or has expired.',
      });
    }

    const tokenPayload = JSON.stringify({
      phone: normalizedPhone,
      purpose: 'rider-password-reset',
      exp: Date.now() + 10 * 60 * 1000,
    });

    const encodedPayload = encodeBase64Url(encoder.encode(tokenPayload));
    const signature = await signPayload(encodedPayload, resetSecret);
    const resetToken = `${encodedPayload}.${signature}`;

    return jsonResponse(200, { success: true, resetToken });
  } catch (error) {
    console.log('[verify-rider-password-reset-otp] unexpected error', error);
    return jsonResponse(500, { error: 'Unexpected password reset verification error' });
  }
});