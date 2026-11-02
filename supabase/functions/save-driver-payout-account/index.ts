// Supabase Edge Function: save-driver-payout-account
// Re-verifies the bank_code + account_number server-side (never trust the
// client-supplied account name) and stores it as the driver's payout destination.
import { createClient } from 'npm:@supabase/supabase-js@2';

const BUDPAY_BASE_URL = 'https://api.budpay.com/api/v2';

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
    const budpaySecretKey = Deno.env.get('BUDPAY_SECRET_KEY');

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey || !budpaySecretKey) {
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
    const bankCode = body?.bankCode as string | undefined;
    const bankName = body?.bankName as string | undefined;
    const accountNumber = body?.accountNumber as string | undefined;

    if (!bankCode || !bankName || !accountNumber) {
      return new Response(JSON.stringify({ error: 'bankCode, bankName and accountNumber are required' }), { status: 400 });
    }

    const verifyResponse = await fetch(`${BUDPAY_BASE_URL}/account_name_verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${budpaySecretKey}`,
      },
      body: JSON.stringify({ bank_code: bankCode, account_number: accountNumber }),
    });

    const verifyResult = await verifyResponse.json();

    if (!verifyResponse.ok || verifyResult?.success !== true) {
      console.log('BudPay account name verification failed:', verifyResult);
      return new Response(
        JSON.stringify({ error: verifyResult?.message || 'Unable to verify account details' }),
        { status: 502 }
      );
    }

    const accountName = verifyResult.data as string;
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const { error: updateError } = await supabaseAdmin
      .from('driver_profile')
      .update({
        payout_bank_code: bankCode,
        payout_bank_name: bankName,
        payout_account_number: accountNumber,
        payout_account_name: accountName,
      })
      .eq('uuid', user.id);

    if (updateError) {
      console.log('Unable to save driver payout account:', updateError);
      return new Response(JSON.stringify({ error: 'Unable to save payout account' }), { status: 500 });
    }

    return new Response(
      JSON.stringify({ bankCode, bankName, accountNumber, accountName }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.log('save-driver-payout-account error:', error);
    return new Response(JSON.stringify({ error: 'Unexpected error saving payout account' }), { status: 500 });
  }
});
