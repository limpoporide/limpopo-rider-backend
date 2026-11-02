const TERMII_BASE_URL = 'https://v4.api.termii.com';
const OTP_LENGTH = 6;

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
    const termiiApiKey = Deno.env.get('TERMII_API_KEY');

    if (!termiiApiKey) {
      return jsonResponse(500, { error: 'OTP service is not configured' });
    }

    const body = (await req.json().catch(() => null)) as { pinId?: string; pin?: string } | null;
    const pinId = body?.pinId?.trim() ?? '';
    const pin = body?.pin?.trim() ?? '';

    if (!pinId) {
      return jsonResponse(400, { error: 'A valid OTP session is required' });
    }

    if (!/^\d{6}$/.test(pin) || pin.length !== OTP_LENGTH) {
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
        pin,
      }),
    });

    const payload = await response.json().catch(() => null);
    const isVerified = String(payload?.verified).toLowerCase() === 'true';

    if (!response.ok || !isVerified) {
      console.log('[verify-phone-otp] Termii verify failed', payload);
      return jsonResponse(response.ok ? 400 : response.status, {
        error: payload?.message ?? payload?.smsStatus ?? 'The OTP code is invalid or has expired.',
      });
    }

    return jsonResponse(200, { success: true, verified: true });
  } catch (error) {
    console.log('[verify-phone-otp] unexpected error', error);
    return jsonResponse(500, { error: 'Unexpected OTP verification error' });
  }
});