// Supabase Edge Function: budpay-webhook
// Public endpoint BudPay calls for wallet top-ups and driver payouts. There is
// only one BudPay webhook URL for the whole business account, so this single
// function fans out to both rider_profile/rider_transaction (top-ups) and
// driver_profile/driver_transaction (top-ups + outgoing payouts).
// Deploy with: supabase functions deploy budpay-webhook --no-verify-jwt
import { createClient } from 'npm:@supabase/supabase-js@2';

const BUDPAY_BASE_URL = 'https://api.budpay.com/api/v2';
const EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push/send';
const DRIVER_NOTIFICATIONS_SCREEN = '/request/notifications';
const DRIVER_RIDE_REQUESTS_CHANNEL_ID = 'ride-requests-v2';
const DRIVER_RIDE_REQUESTS_SOUND = 'ping-ping.wav';

type DriverPushProfile = {
  uuid: string;
  first_name: string;
  expo_push_token: string | null;
  push_notification: boolean;
};

const isExpoPushToken = (value: string | null) => {
  if (!value) {
    return false;
  }

  return /^Expo(nent)?PushToken\[.+\]$/.test(value);
};

const formatNairaAmount = (amount: number) => `NGN ${Math.round(amount).toLocaleString('en-NG')}`;

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const budpaySecretKey = Deno.env.get('BUDPAY_SECRET_KEY');

    if (!supabaseUrl || !supabaseServiceRoleKey || !budpaySecretKey) {
      return new Response(JSON.stringify({ error: 'Server is misconfigured' }), { status: 500 });
    }

    const payload = await req.json().catch(() => null);

    if (!payload) {
      return new Response(JSON.stringify({ error: 'Invalid payload' }), { status: 400 });
    }

    const { notify, notifyType, data } = payload;
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    if (notify === 'payout') {
      return await handlePayoutWebhook(supabaseAdmin, data, notifyType);
    }

    // 'transfer' covers direct bank-transfer ride payments — BudPay's own async
    // webhook for those uses this channel and was previously dropped here,
    // which silently prevented Direct Transfer rides from ever being settled.
    const isWalletTopup =
      notify === 'transaction' &&
      (data?.channel === 'dedicated_account' || data?.channel === 'card' || data?.channel === 'transfer');

    if (!isWalletTopup || notifyType !== 'successful') {
      // Acknowledge everything else so BudPay doesn't keep retrying.
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }

    const reference: string | undefined = data?.reference;

    if (!reference) {
      return new Response(JSON.stringify({ error: 'Missing transaction reference' }), { status: 400 });
    }

    // Idempotency guard: BudPay retries webhooks up to 3 times. Reference is
    // unique across both rider_transaction and driver_transaction.
    const [{ data: existingRiderTx }, { data: existingDriverTx }] = await Promise.all([
      supabaseAdmin.from('rider_transaction').select('id').eq('reference', reference).maybeSingle(),
      supabaseAdmin.from('driver_transaction').select('id').eq('reference', reference).maybeSingle(),
    ]);

    if (existingRiderTx || existingDriverTx) {
      return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });
    }

    // Never trust the webhook body alone — re-verify server-side before crediting.
    const verifyResponse = await fetch(`${BUDPAY_BASE_URL}/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${budpaySecretKey}` },
    });

    const verifyResult = await verifyResponse.json();

    if (!verifyResponse.ok || !verifyResult?.status || verifyResult.data?.status !== 'success') {
      console.log('BudPay verification failed for reference:', reference, verifyResult);
      return new Response(JSON.stringify({ error: 'Transaction could not be verified' }), { status: 400 });
    }

    const verifiedData = verifyResult.data;
    // Bank-transfer credits carry a receiver account number; card checkouts carry a customer email instead.
    const receiverAccountNumber: string | undefined = verifiedData.receiver_account_number;
    const customerEmail: string | undefined = verifiedData.customer?.email;

    if (!receiverAccountNumber && !customerEmail) {
      return new Response(JSON.stringify({ error: 'Transaction has no matchable identifier' }), { status: 400 });
    }

    // `amount` is the net amount BudPay actually credits (after fees); `requested_amount`
    // is the original amount the sender transferred.
    const creditedAmount = Number(verifiedData.amount ?? verifiedData.requested_amount ?? 0);
    // Prefer our own client-sent bookingId, fall back to BudPay-echoed checkout metadata
    // so a genuine async BudPay webhook (no client wrapper) can still resolve the ride.
    const metadataBookingId = typeof verifiedData.metadata?.bookingId === 'string' ? verifiedData.metadata.bookingId : '';
    const rideBookingId = typeof data?.bookingId === 'string' && data.bookingId.trim()
      ? data.bookingId.trim()
      : metadataBookingId.trim();

    let paidAt: string | null = null;
    if (verifiedData.transaction_date) {
      const parsed = new Date(String(verifiedData.transaction_date).replace(' ', 'T'));
      if (!isNaN(parsed.getTime())) {
        paidAt = parsed.toISOString();
      }
    }

    if (rideBookingId) {
      return await confirmRidePayment(supabaseAdmin, rideBookingId, {
        reference,
        verifiedData,
        creditedAmount,
        paidAt,
        payload,
      });
    }

    // Try the rider first, then the driver — wallet_account/email are unique per profile table.
    const riderQuery = receiverAccountNumber
      ? supabaseAdmin.from('rider_profile').select('uuid').eq('wallet_account', receiverAccountNumber)
      : supabaseAdmin.from('rider_profile').select('uuid').eq('email', customerEmail);
    const { data: riderProfile } = await riderQuery.maybeSingle();

    if (riderProfile) {
      return await creditRiderWallet(supabaseAdmin, riderProfile.uuid, {
        reference,
        verifiedData,
        creditedAmount,
        paidAt,
        payload,
      });
    }

    const driverQuery = receiverAccountNumber
      ? supabaseAdmin.from('driver_profile').select('uuid').eq('wallet_account', receiverAccountNumber)
      : supabaseAdmin.from('driver_profile').select('uuid').eq('email', customerEmail);
    const { data: driverProfile } = await driverQuery.maybeSingle();

    if (driverProfile) {
      return await creditDriverWallet(supabaseAdmin, driverProfile.uuid, {
        reference,
        verifiedData,
        creditedAmount,
        paidAt,
        payload,
      });
    }

    console.log('No rider or driver profile matches transaction:', receiverAccountNumber ?? customerEmail);
    return new Response(JSON.stringify({ error: 'Profile not found for transaction' }), { status: 404 });
  } catch (error) {
    console.log('budpay-webhook error:', error);
    return new Response(JSON.stringify({ error: 'Unexpected error processing webhook' }), { status: 500 });
  }
});

type CreditArgs = {
  reference: string;
  verifiedData: any;
  creditedAmount: number;
  paidAt: string | null;
  payload: unknown;
};

async function confirmRidePayment(
  supabaseAdmin: ReturnType<typeof createClient>,
  bookingId: string,
  args: CreditArgs
) {
  const { reference, verifiedData, creditedAmount, paidAt, payload } = args;

  const { data, error } = await supabaseAdmin.rpc('confirm_ride_payment', {
    p_booking_id: bookingId,
    p_reference: reference,
    p_channel: verifiedData.channel ?? 'card',
    p_gateway: 'budpay',
    p_currency: verifiedData.currency || 'NGN',
    p_amount: Number(verifiedData.requested_amount ?? creditedAmount),
    p_requested_amount: Number(verifiedData.requested_amount ?? creditedAmount),
    p_paid_at: paidAt,
    p_raw_payload: payload,
  });

  if (error) {
    console.log('Unable to confirm ride payment:', error);
    return new Response(JSON.stringify({ error: 'Unable to confirm ride payment' }), { status: 500 });
  }

  const paymentResult = (data ?? { status: 'paid', paymentStatus: 'unpaid' }) as {
    status?: string;
    paymentStatus?: 'unpaid' | 'paid';
    driverCredited?: boolean;
    walletJustCredited?: boolean;
    driverUuid?: string | null;
    amount?: number;
  };

  if (paymentResult.walletJustCredited && paymentResult.driverUuid) {
    await notifyDriverRideSettlement(supabaseAdmin, {
      bookingId,
      driverUuid: paymentResult.driverUuid,
      amount: Number(paymentResult.amount ?? creditedAmount),
    });
  }

  return new Response(JSON.stringify(paymentResult), { status: 200 });
}

async function notifyDriverRideSettlement(
  supabaseAdmin: ReturnType<typeof createClient>,
  args: { bookingId: string; driverUuid: string; amount: number }
) {
  const { bookingId, driverUuid, amount } = args;
  const title = 'Ride payment received';
  const body = `Your wallet has been credited with ${formatNairaAmount(amount)} for booking ${bookingId.slice(0, 8)}.`;

  const { error: notificationInsertError } = await supabaseAdmin.from('notifications').insert({
    recipient_id: driverUuid,
    recipient_role: 'driver',
    type: 'ride_payment_settled',
    title,
    body,
    data: {
      bookingId,
      source: 'rider_booking',
      screen: DRIVER_NOTIFICATIONS_SCREEN,
      paymentStatus: 'paid',
    },
  });

  if (notificationInsertError) {
    console.log('Unable to create driver settlement notification:', notificationInsertError);
  }

  const { data: driverProfile, error: driverError } = await supabaseAdmin
    .from('driver_profile')
    .select('uuid, first_name, expo_push_token, push_notification')
    .eq('uuid', driverUuid)
    .maybeSingle<DriverPushProfile>();

  if (driverError) {
    console.log('Unable to load driver push profile for settlement notification:', driverError);
    return;
  }

  if (!driverProfile?.push_notification || !isExpoPushToken(driverProfile.expo_push_token)) {
    return;
  }

  const expoResponse = await fetch(EXPO_PUSH_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate',
    },
    body: JSON.stringify([
      {
        to: driverProfile.expo_push_token,
        title,
        body,
        sound: DRIVER_RIDE_REQUESTS_SOUND,
        priority: 'high',
        channelId: DRIVER_RIDE_REQUESTS_CHANNEL_ID,
        data: {
          bookingId,
          source: 'rider_booking',
          paymentStatus: 'paid',
          screen: DRIVER_NOTIFICATIONS_SCREEN,
        },
      },
    ]),
  });

  if (!expoResponse.ok) {
    const expoResult = await expoResponse.json().catch(() => null);
    console.log('Driver settlement push failed:', expoResult);
  }
}

async function creditRiderWallet(supabaseAdmin: ReturnType<typeof createClient>, riderUuid: string, args: CreditArgs) {
  const { reference, verifiedData, creditedAmount, paidAt, payload } = args;

  const { error: insertError } = await supabaseAdmin.from('rider_transaction').insert({
    rider_uuid: riderUuid,
    reference,
    type: 'wallet_topup',
    status: 'success',
    channel: verifiedData.channel,
    gateway: 'budpay',
    currency: verifiedData.currency || 'NGN',
    amount: creditedAmount,
    fees: Number(verifiedData.fees ?? 0),
    requested_amount: Number(verifiedData.requested_amount ?? creditedAmount),
    sender_name: verifiedData.originator_name ?? null,
    sender_account: verifiedData.originator_account_number ?? null,
    narration: verifiedData.originator_narration ?? null,
    paid_at: paidAt,
    raw_payload: payload,
  });

  if (insertError) {
    if (insertError.code === '23505') {
      return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });
    }

    console.log('Unable to record rider transaction:', insertError);
    return new Response(JSON.stringify({ error: 'Unable to record transaction' }), { status: 500 });
  }

  const { error: incrementError } = await supabaseAdmin.rpc('increment_wallet_balance', {
    p_rider_uuid: riderUuid,
    p_amount: creditedAmount,
  });

  if (incrementError) {
    console.log('Unable to increment rider wallet balance:', incrementError);
    return new Response(JSON.stringify({ error: 'Unable to update wallet balance' }), { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), { status: 200 });
}

async function creditDriverWallet(supabaseAdmin: ReturnType<typeof createClient>, driverUuid: string, args: CreditArgs) {
  const { reference, verifiedData, creditedAmount, paidAt, payload } = args;

  const { error: insertError } = await supabaseAdmin.from('driver_transaction').insert({
    driver_uuid: driverUuid,
    reference,
    type: 'wallet_topup',
    status: 'success',
    channel: verifiedData.channel,
    gateway: 'budpay',
    currency: verifiedData.currency || 'NGN',
    amount: creditedAmount,
    requested_amount: Number(verifiedData.requested_amount ?? creditedAmount),
    sender_name: verifiedData.originator_name ?? null,
    sender_account: verifiedData.originator_account_number ?? null,
    narration: verifiedData.originator_narration ?? null,
    paid_at: paidAt,
    raw_payload: payload,
  });

  if (insertError) {
    if (insertError.code === '23505') {
      return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });
    }

    console.log('Unable to record driver transaction:', insertError);
    return new Response(JSON.stringify({ error: 'Unable to record transaction' }), { status: 500 });
  }

  const { error: incrementError } = await supabaseAdmin.rpc('increment_driver_wallet_balance', {
    p_driver_uuid: driverUuid,
    p_amount: creditedAmount,
  });

  if (incrementError) {
    console.log('Unable to increment driver wallet balance:', incrementError);
    return new Response(JSON.stringify({ error: 'Unable to update wallet balance' }), { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), { status: 200 });
}

// Payouts are only initiated from the driver app, so this only ever touches driver_transaction.
async function handlePayoutWebhook(supabaseAdmin: ReturnType<typeof createClient>, data: any, notifyType: string) {
  const reference: string | undefined = data?.reference;

  if (!reference) {
    return new Response(JSON.stringify({ error: 'Missing payout reference' }), { status: 400 });
  }

  const nextStatus = notifyType === 'successful' ? 'success' : notifyType === 'failed' ? 'failed' : 'pending';

  // Only transition rows that are still pending, so retried webhooks can't double-refund.
  const { data: updatedRows, error: updateError } = await supabaseAdmin
    .from('driver_transaction')
    .update({ status: nextStatus, raw_payload: data })
    .eq('reference', reference)
    .eq('status', 'pending')
    .select('id, driver_uuid, amount')
    .maybeSingle();

  if (updateError) {
    console.log('Unable to update driver payout status:', updateError);
    return new Response(JSON.stringify({ error: 'Unable to update payout status' }), { status: 500 });
  }

  if (updatedRows && nextStatus === 'failed') {
    // The amount was held from the wallet when the payout was initiated — give it back.
    const { error: refundError } = await supabaseAdmin.rpc('increment_driver_wallet_balance', {
      p_driver_uuid: updatedRows.driver_uuid,
      p_amount: Number(updatedRows.amount),
    });

    if (refundError) {
      console.log('Unable to refund failed driver payout:', refundError);
    }
  }

  return new Response(JSON.stringify({ received: true }), { status: 200 });
}

