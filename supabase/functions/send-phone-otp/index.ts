const TERMII_BASE_URL = 'https://v4.api.termii.com';
const TERMII_SENDER_ID = Deno.env.get('TERMII_SENDER_ID') ?? 'OE Alert';
const TERMII_OTP_CHANNEL = Deno.env.get('TERMII_OTP_CHANNEL') ?? 'dnd';
const OTP_LENGTH = 6;

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
    const termiiApiKey = Deno.env.get('TERMII_API_KEY');

    if (!termiiApiKey) {
      return jsonResponse(500, { error: 'OTP service is not configured' });
    }

    const body = (await req.json().catch(() => null)) as { phone?: string } | null;
    const normalizedPhone = normalizePhoneNumber(body?.phone);

    if (!normalizedPhone) {
      return jsonResponse(400, { error: 'A valid phone number is required' });
    }

    const response = await fetch(`${TERMII_BASE_URL}/api/sms/otp/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: termiiApiKey,
        message_type: 'NUMERIC',
        to: normalizedPhone.replace(/^\+/, ''),
        from: TERMII_SENDER_ID,
        channel: TERMII_OTP_CHANNEL,
        pin_attempts: 3,
        pin_time_to_live: 5,
        pin_length: OTP_LENGTH,
        pin_placeholder: '< 123456 >',
        message_text: 'Your Limpopo verification code is < 123456 >',
        pin_type: 'NUMERIC',
      }),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      console.log('[send-phone-otp] Termii send failed', payload);
      return jsonResponse(response.status, { error: payload?.message ?? payload?.smsStatus ?? 'Unable to send OTP right now.' });
    }

    const pinId = typeof payload?.pinId === 'string'
      ? payload.pinId
      : typeof payload?.pin_id === 'string'
        ? payload.pin_id
        : '';

    if (!pinId) {
      return jsonResponse(502, { error: 'We could not start verification right now. Please try again.' });
    }

    return jsonResponse(200, { success: true, pinId });
  } catch (error) {
    console.log('[send-phone-otp] unexpected error', error);
    return jsonResponse(500, { error: 'Unexpected OTP delivery error' });
  }
});