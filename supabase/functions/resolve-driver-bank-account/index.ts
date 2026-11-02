// Supabase Edge Function: resolve-driver-bank-account
// Validates a bank_code + account_number pair via BudPay before the driver
// saves it as their payout destination. Does not persist anything.
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
    const budpaySecretKey = Deno.env.get('BUDPAY_SECRET_KEY');

    if (!supabaseUrl || !supabaseAnonKey || !budpaySecretKey) {
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
    const accountNumber = body?.accountNumber as string | undefined;

    if (!bankCode || !accountNumber) {
      return new Response(JSON.stringify({ error: 'bankCode and accountNumber are required' }), { status: 400 });
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

    return new Response(
      JSON.stringify({ accountName: verifyResult.data as string }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.log('resolve-driver-bank-account error:', error);
    return new Response(JSON.stringify({ error: 'Unexpected error verifying account' }), { status: 500 });
  }
});
