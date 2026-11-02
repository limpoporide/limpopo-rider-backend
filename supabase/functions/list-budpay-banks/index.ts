// Supabase Edge Function: list-budpay-banks
// Proxies BudPay's NGN bank list so the client never sees the secret key.
import { createClient } from 'npm:@supabase/supabase-js@2';

const BUDPAY_BASE_URL = 'https://api.budpay.com/api/v2';

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
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

    const banksResponse = await fetch(`${BUDPAY_BASE_URL}/bank_list/NGN`, {
      headers: { Authorization: `Bearer ${budpaySecretKey}` },
    });

    const banksResult = await banksResponse.json();

    if (!banksResponse.ok || banksResult?.success !== true) {
      console.log('BudPay bank list failed:', banksResult);
      return new Response(
        JSON.stringify({ error: banksResult?.message || 'Unable to fetch bank list' }),
        { status: 502 }
      );
    }

    const seenBankCodes = new Set<string>();
    const banks = (banksResult.data ?? [])
      .filter((bank: { bank_code: string }) => {
        if (seenBankCodes.has(bank.bank_code)) {
          return false;
        }
        seenBankCodes.add(bank.bank_code);
        return true;
      })
      .map((bank: { bank_name: string; bank_code: string }) => ({
        bankName: bank.bank_name,
        bankCode: bank.bank_code,
      }));

    return new Response(JSON.stringify({ banks }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.log('list-budpay-banks error:', error);
    return new Response(JSON.stringify({ error: 'Unexpected error fetching bank list' }), { status: 500 });
  }
});
