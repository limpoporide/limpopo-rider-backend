// Supabase Edge Function: create-virtual-account
// Creates a BudPay dedicated virtual account for the calling rider and stores
// the result on rider_profile (wallet_account, bank_name, account_name).
//
// The BudPay secret key never reaches the client — it stays in Supabase's
// server-side secrets store (set via `supabase secrets set BUDPAY_SECRET_KEY=...`).
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

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      return new Response(JSON.stringify({ error: 'Server is misconfigured' }), { status: 500 });
    }

    if (!budpaySecretKey) {
      return new Response(JSON.stringify({ error: 'BudPay secret key is not configured' }), { status: 500 });
    }

    // Scoped client used only to verify who is calling.
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

    // Admin client to read/write rider_profile regardless of RLS.
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('rider_profile')
      .select('uuid, first_name, last_name, email, phone_num, wallet_account, bank_name, account_name, budpay_customer_code')
      .eq('uuid', user.id)
      .single();

    if (profileError || !profile) {
      return new Response(JSON.stringify({ error: 'Rider profile not found' }), { status: 404 });
    }

    // Idempotent: return the existing account if one was already provisioned.
    if (profile.wallet_account && profile.bank_name && profile.account_name) {
      return new Response(
        JSON.stringify({
          walletAccount: profile.wallet_account,
          bankName: profile.bank_name,
          accountName: profile.account_name,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const budpayHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${budpaySecretKey}`,
    };

    // Step 1: create (or reuse) a BudPay customer for this rider.
    let customerCode = profile.budpay_customer_code as string | null;

    if (!customerCode) {
      const customerResponse = await fetch(`${BUDPAY_BASE_URL}/customer`, {
        method: 'POST',
        headers: budpayHeaders,
        body: JSON.stringify({
          email: profile.email,
          first_name: profile.first_name,
          last_name: profile.last_name,
          phone: profile.phone_num,
        }),
      });

      const customerResult = await customerResponse.json();

      if (!customerResponse.ok || !customerResult?.status) {
        console.log('BudPay customer creation failed:', customerResult);
        return new Response(
          JSON.stringify({ error: customerResult?.message || 'Unable to create BudPay customer' }),
          { status: 502 }
        );
      }

      customerCode = customerResult.data.customer_code;

      await supabaseAdmin.from('rider_profile').update({ budpay_customer_code: customerCode }).eq('uuid', user.id);
    }

    // Step 2: create the dedicated virtual account for that customer.
    const virtualAccountResponse = await fetch(`${BUDPAY_BASE_URL}/dedicated_virtual_account`, {
      method: 'POST',
      headers: budpayHeaders,
      body: JSON.stringify({ customer: customerCode }),
    });

    const virtualAccountResult = await virtualAccountResponse.json();

    if (!virtualAccountResponse.ok || !virtualAccountResult?.status) {
      console.log('BudPay virtual account creation failed:', virtualAccountResult);
      return new Response(
        JSON.stringify({ error: virtualAccountResult?.message || 'Unable to create virtual account' }),
        { status: 502 }
      );
    }

    const account = virtualAccountResult.data;

    // Step 3: persist the account details on the rider profile.
    const { error: updateError } = await supabaseAdmin
      .from('rider_profile')
      .update({
        wallet_account: String(account.account_number),
        bank_name: account.bank?.name ?? null,
        account_name: account.account_name ?? null,
      })
      .eq('uuid', user.id);

    if (updateError) {
      console.log('Unable to save virtual account to rider profile:', updateError);
      return new Response(JSON.stringify({ error: 'Unable to save virtual account details' }), { status: 500 });
    }

    return new Response(
      JSON.stringify({
        walletAccount: String(account.account_number),
        bankName: account.bank?.name ?? null,
        accountName: account.account_name ?? null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.log('create-virtual-account error:', error);
    return new Response(JSON.stringify({ error: 'Unexpected error creating virtual account' }), { status: 500 });
  }
});
