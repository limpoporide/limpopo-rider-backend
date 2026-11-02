import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { HttpException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../supabase/supabase.service';

const BUDPAY_BASE_URL = 'https://api.budpay.com/api/v2';
const EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push/send';
const DRIVER_NOTIFICATIONS_SCREEN = '/request/notifications';
const DRIVER_RIDE_REQUESTS_CHANNEL_ID = 'ride-requests-v2';
const DRIVER_RIDE_REQUESTS_SOUND = 'ping-ping.wav';
const MIN_PAYOUT_AMOUNT = 100;

type PaymentBody = Record<string, any> | null;
export type PaymentsResponse = { status: number; body: Record<string, any> };
type CreditArgs = {
  reference: string;
  verifiedData: Record<string, any>;
  creditedAmount: number;
  paidAt: string | null;
  payload: unknown;
};

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  async listBudpayBanks(authorization?: string): Promise<PaymentsResponse> {
    return this.execute('list-budpay-banks', 'Unexpected error fetching bank list', async () => {
      if (!authorization) this.fail(401, 'Missing authorization header');
      this.requireEnv('SUPABASE_URL', 'SUPABASE_ANON_KEY', 'BUDPAY_SECRET_KEY');
      await this.getUser(authorization);

      const banksResponse = await fetch(`${BUDPAY_BASE_URL}/bank_list/NGN`, {
        headers: { Authorization: this.budpayAuthorization() },
      });
      const banksResult = await banksResponse.json();

      if (!banksResponse.ok || banksResult?.success !== true) {
        this.logger.warn(`BudPay bank list failed: ${JSON.stringify(banksResult)}`);
        this.fail(502, banksResult?.message || 'Unable to fetch bank list');
      }

      const seenBankCodes = new Set<string>();
      const banks = (banksResult.data ?? [])
        .filter((bank: { bank_code: string }) => {
          if (seenBankCodes.has(bank.bank_code)) return false;
          seenBankCodes.add(bank.bank_code);
          return true;
        })
        .map((bank: { bank_name: string; bank_code: string }) => ({
          bankName: bank.bank_name,
          bankCode: bank.bank_code,
        }));

      return this.result(200, { banks });
    });
  }

  async resolveDriverBankAccount(authorization?: string, body?: PaymentBody): Promise<PaymentsResponse> {
    return this.execute('resolve-driver-bank-account', 'Unexpected error verifying account', async () => {
      if (!authorization) this.fail(401, 'Missing authorization header');
      this.requireEnv('SUPABASE_URL', 'SUPABASE_ANON_KEY', 'BUDPAY_SECRET_KEY');
      await this.getUser(authorization);

      const bankCode = body?.bankCode as string | undefined;
      const accountNumber = body?.accountNumber as string | undefined;
      if (!bankCode || !accountNumber) this.fail(400, 'bankCode and accountNumber are required');

      const verifyResponse = await fetch(`${BUDPAY_BASE_URL}/account_name_verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: this.budpayAuthorization() },
        body: JSON.stringify({ bank_code: bankCode, account_number: accountNumber }),
      });
      const verifyResult = await verifyResponse.json();

      if (!verifyResponse.ok || verifyResult?.success !== true) {
        this.logger.warn(`BudPay account name verification failed: ${JSON.stringify(verifyResult)}`);
        this.fail(502, verifyResult?.message || 'Unable to verify account details');
      }

      return this.result(200, { accountName: verifyResult.data as string });
    });
  }

  async saveDriverPayoutAccount(authorization?: string, body?: PaymentBody): Promise<PaymentsResponse> {
    return this.execute('save-driver-payout-account', 'Unexpected error saving payout account', async () => {
      if (!authorization) this.fail(401, 'Missing authorization header');
      this.requireEnv('SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'BUDPAY_SECRET_KEY');
      const user = await this.getUser(authorization);

      const bankCode = body?.bankCode as string | undefined;
      const bankName = body?.bankName as string | undefined;
      const accountNumber = body?.accountNumber as string | undefined;
      if (!bankCode || !bankName || !accountNumber) {
        this.fail(400, 'bankCode, bankName and accountNumber are required');
      }

      const verifyResponse = await fetch(`${BUDPAY_BASE_URL}/account_name_verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: this.budpayAuthorization() },
        body: JSON.stringify({ bank_code: bankCode, account_number: accountNumber }),
      });
      const verifyResult = await verifyResponse.json();

      if (!verifyResponse.ok || verifyResult?.success !== true) {
        this.logger.warn(`BudPay account name verification failed: ${JSON.stringify(verifyResult)}`);
        this.fail(502, verifyResult?.message || 'Unable to verify account details');
      }

      const accountName = verifyResult.data as string;
      const { error: updateError } = await this.supabase.admin
        .from('driver_profile')
        .update({
          payout_bank_code: bankCode,
          payout_bank_name: bankName,
          payout_account_number: accountNumber,
          payout_account_name: accountName,
        })
        .eq('uuid', user.id);

      if (updateError) {
        this.logger.error(`Unable to save driver payout account: ${JSON.stringify(updateError)}`);
        this.fail(500, 'Unable to save payout account');
      }

      return this.result(200, { bankCode, bankName, accountNumber, accountName });
    });
  }

  async setDriverTransferPin(authorization?: string, body?: PaymentBody): Promise<PaymentsResponse> {
    return this.execute('set-driver-transfer-pin', 'Unexpected error setting transfer PIN', async () => {
      if (!authorization) this.fail(401, 'Missing authorization header');
      this.requireEnv('SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
      const user = await this.getUser(authorization);
      const pin = body?.pin as string | undefined;

      if (!pin || !/^\d{4,6}$/.test(pin)) this.fail(400, 'PIN must be 4 to 6 digits');

      const { error: rpcError } = await this.supabase.admin.rpc('set_driver_transfer_pin', {
        p_driver_uuid: user.id,
        p_pin: pin,
      });

      if (rpcError) {
        this.logger.error(`Unable to set driver transfer PIN: ${JSON.stringify(rpcError)}`);
        this.fail(500, 'Unable to set transfer PIN');
      }

      return this.result(200, { success: true });
    });
  }

  async createVirtualAccount(authorization: string | undefined, profileType: 'driver' | 'rider'): Promise<PaymentsResponse> {
    const functionName = profileType === 'driver' ? 'create-driver-virtual-account' : 'create-virtual-account';
    const profileLabel = profileType === 'driver' ? 'Driver' : 'Rider';
    const table = profileType === 'driver' ? 'driver_profile' : 'rider_profile';

    return this.execute(functionName, 'Unexpected error creating virtual account', async () => {
      if (!authorization) this.fail(401, 'Missing authorization header');
      this.requireEnv('SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
      if (!this.config.get<string>('BUDPAY_SECRET_KEY')) {
        this.fail(500, 'BudPay secret key is not configured');
      }

      const user = await this.getUser(authorization);
      const admin = this.supabase.admin;
      const { data: profile, error: profileError } = await admin
        .from(table)
        .select('uuid, first_name, last_name, email, phone_num, wallet_account, bank_name, account_name, budpay_customer_code')
        .eq('uuid', user.id)
        .single();

      if (profileError || !profile) this.fail(404, `${profileLabel} profile not found`);

      if (profile.wallet_account && profile.bank_name && profile.account_name) {
        return this.result(200, {
          walletAccount: profile.wallet_account,
          bankName: profile.bank_name,
          accountName: profile.account_name,
        });
      }

      const budpayHeaders = {
        'Content-Type': 'application/json',
        Authorization: this.budpayAuthorization(),
      };
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
          this.logger.warn(`BudPay customer creation failed: ${JSON.stringify(customerResult)}`);
          this.fail(502, customerResult?.message || 'Unable to create BudPay customer');
        }

        customerCode = customerResult.data.customer_code;
        await admin.from(table).update({ budpay_customer_code: customerCode }).eq('uuid', user.id);
      }

      const virtualAccountResponse = await fetch(`${BUDPAY_BASE_URL}/dedicated_virtual_account`, {
        method: 'POST',
        headers: budpayHeaders,
        body: JSON.stringify({ customer: customerCode }),
      });
      const virtualAccountResult = await virtualAccountResponse.json();

      if (!virtualAccountResponse.ok || !virtualAccountResult?.status) {
        this.logger.warn(`BudPay virtual account creation failed: ${JSON.stringify(virtualAccountResult)}`);
        this.fail(502, virtualAccountResult?.message || 'Unable to create virtual account');
      }

      const account = virtualAccountResult.data;
      const { error: updateError } = await admin
        .from(table)
        .update({
          wallet_account: String(account.account_number),
          bank_name: account.bank?.name ?? null,
          account_name: account.account_name ?? null,
        })
        .eq('uuid', user.id);

      if (updateError) {
        this.logger.error(`Unable to save virtual account to ${profileType} profile: ${JSON.stringify(updateError)}`);
        this.fail(500, 'Unable to save virtual account details');
      }

      return this.result(200, {
        walletAccount: String(account.account_number),
        bankName: account.bank?.name ?? null,
        accountName: account.account_name ?? null,
      });
    });
  }

  async createDriverPayout(authorization?: string, body?: PaymentBody): Promise<PaymentsResponse> {
    return this.execute('create-driver-payout', 'Unexpected error initiating payout', async () => {
      if (!authorization) this.fail(401, 'Missing authorization header');
      this.requireEnv(
        'SUPABASE_URL',
        'SUPABASE_ANON_KEY',
        'SUPABASE_SERVICE_ROLE_KEY',
        'BUDPAY_PROXY_URL',
        'BUDPAY_PROXY_SIGNING_SECRET',
      );
      const user = await this.getUser(authorization);
      const amount = Number(body?.amount);
      const pin = body?.pin as string | undefined;
      const narration = (body?.narration as string | undefined)?.trim() || 'Limpopo driver payout';

      if (!amount || amount < MIN_PAYOUT_AMOUNT) {
        this.fail(400, `Enter an amount of at least ${MIN_PAYOUT_AMOUNT}`);
      }
      if (!pin || !/^\d{4,6}$/.test(pin)) this.fail(400, 'Enter your transfer PIN');

      const admin = this.supabase.admin;
      const { data: profile, error: profileError } = await admin
        .from('driver_profile')
        .select('uuid, wallet_balance, payout_bank_code, payout_bank_name, payout_account_number, payout_account_name, transfer_pin')
        .eq('uuid', user.id)
        .single();

      if (profileError || !profile) this.fail(404, 'Driver profile not found');
      if (!profile.payout_bank_code || !profile.payout_account_number) {
        this.fail(400, 'Add a payout bank account before withdrawing');
      }
      if (!profile.transfer_pin) this.fail(400, 'Set a transfer PIN before withdrawing');

      const { data: isPinValid, error: pinError } = await admin.rpc('verify_driver_transfer_pin', {
        p_driver_uuid: user.id,
        p_pin: pin,
      });
      if (pinError) {
        this.logger.error(`Unable to verify driver transfer PIN: ${JSON.stringify(pinError)}`);
        this.fail(500, 'Unable to verify transfer PIN');
      }
      if (!isPinValid) this.fail(401, 'Incorrect transfer PIN');

      const { data: didHold, error: holdError } = await admin.rpc('decrement_driver_wallet_balance_if_sufficient', {
        p_driver_uuid: user.id,
        p_amount: amount,
      });
      if (holdError) {
        this.logger.error(`Unable to hold driver wallet balance: ${JSON.stringify(holdError)}`);
        this.fail(500, 'Unable to process payout');
      }
      if (!didHold) this.fail(400, 'Insufficient wallet balance');

      const transferPayload = JSON.stringify({
        currency: 'NGN',
        amount: String(amount),
        bank_code: profile.payout_bank_code,
        bank_name: profile.payout_bank_name,
        account_number: profile.payout_account_number,
        narration,
      });
      const requestId = randomUUID();
      const timestamp = new Date().toISOString();
      const proxySignature = createHmac('sha256', this.config.get<string>('BUDPAY_PROXY_SIGNING_SECRET')!)
        .update(`${timestamp}.${requestId}.${transferPayload}`)
        .digest('hex');
      const transferResponse = await fetch(`${this.config.get<string>('BUDPAY_PROXY_URL')}/v1/budpay/bank-transfer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Limpopo-Timestamp': timestamp,
          'X-Limpopo-Request-Id': requestId,
          'X-Limpopo-Signature': proxySignature,
        },
        body: transferPayload,
      });
      const transferResult = await transferResponse.json().catch(() => null);

      if (!transferResponse.ok || !transferResult?.success) {
        await admin.rpc('increment_driver_wallet_balance', { p_driver_uuid: user.id, p_amount: amount });
        this.logger.warn(`BudPay bank transfer failed: ${JSON.stringify(transferResult)}`);
        this.fail(502, transferResult?.message || 'Unable to initiate payout');
      }

      const transfer = transferResult.data;
      const { error: insertError } = await admin.from('driver_transaction').insert({
        driver_uuid: user.id,
        reference: transfer.reference,
        type: 'payout',
        status: transfer.status || 'pending',
        gateway: 'budpay',
        currency: transfer.currency || 'NGN',
        amount,
        fee: Number(transfer.fee ?? 0),
        bank_code: transfer.bank_code ?? profile.payout_bank_code,
        bank_name: transfer.bank_name ?? profile.payout_bank_name,
        account_number: transfer.account_number ?? profile.payout_account_number,
        account_name: transfer.account_name ?? profile.payout_account_name,
        narration,
        raw_payload: transferResult,
      });

      if (insertError) {
        this.logger.error(`Unable to record driver payout transaction: ${JSON.stringify(insertError)}`);
      }

      return this.result(200, {
        reference: transfer.reference,
        status: transfer.status,
        amount,
        fee: Number(transfer.fee ?? 0),
      });
    });
  }

  async budpayWebhook(signature: string | undefined, rawBody?: Buffer): Promise<PaymentsResponse> {
    return this.execute('budpay-webhook', 'Unexpected error processing webhook', async () => {
      this.requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'BUDPAY_SECRET_KEY');
      if (!this.validWebhookSignature(signature, rawBody)) this.fail(401, 'Invalid webhook signature');

      let payload: any = null;
      try {
        payload = rawBody ? JSON.parse(rawBody.toString('utf8')) : null;
      } catch {
        payload = null;
      }
      if (!payload) this.fail(400, 'Invalid payload');

      const { notify, notifyType, data } = payload;
      const admin = this.supabase.admin;
      if (notify === 'payout') return this.handlePayoutWebhook(admin, data, notifyType);

      const isWalletTopup =
        notify === 'transaction' &&
        (data?.channel === 'dedicated_account' || data?.channel === 'card' || data?.channel === 'transfer');
      if (!isWalletTopup || notifyType !== 'successful') return this.result(200, { received: true });

      const reference: string | undefined = data?.reference;
      if (!reference) this.fail(400, 'Missing transaction reference');

      const [{ data: existingRiderTx }, { data: existingDriverTx }] = await Promise.all([
        admin.from('rider_transaction').select('id').eq('reference', reference).maybeSingle(),
        admin.from('driver_transaction').select('id').eq('reference', reference).maybeSingle(),
      ]);
      if (existingRiderTx || existingDriverTx) return this.result(200, { received: true, duplicate: true });

      const verifyResponse = await fetch(`${BUDPAY_BASE_URL}/transaction/verify/${reference}`, {
        headers: { Authorization: this.budpayAuthorization() },
      });
      const verifyResult = await verifyResponse.json();
      if (!verifyResponse.ok || !verifyResult?.status || verifyResult.data?.status !== 'success') {
        this.logger.warn(`BudPay verification failed for reference ${reference}: ${JSON.stringify(verifyResult)}`);
        this.fail(400, 'Transaction could not be verified');
      }

      const verifiedData = verifyResult.data;
      const receiverAccountNumber: string | undefined = verifiedData.receiver_account_number;
      const customerEmail: string | undefined = verifiedData.customer?.email;
      if (!receiverAccountNumber && !customerEmail) this.fail(400, 'Transaction has no matchable identifier');

      const creditedAmount = Number(verifiedData.amount ?? verifiedData.requested_amount ?? 0);
      const metadataBookingId = typeof verifiedData.metadata?.bookingId === 'string' ? verifiedData.metadata.bookingId : '';
      const rideBookingId = typeof data?.bookingId === 'string' && data.bookingId.trim()
        ? data.bookingId.trim()
        : metadataBookingId.trim();
      let paidAt: string | null = null;
      if (verifiedData.transaction_date) {
        const parsed = new Date(String(verifiedData.transaction_date).replace(' ', 'T'));
        if (!isNaN(parsed.getTime())) paidAt = parsed.toISOString();
      }

      const args: CreditArgs = { reference, verifiedData, creditedAmount, paidAt, payload };
      if (rideBookingId) return this.confirmRidePayment(admin, rideBookingId, args);

      const riderQuery = receiverAccountNumber
        ? admin.from('rider_profile').select('uuid').eq('wallet_account', receiverAccountNumber)
        : admin.from('rider_profile').select('uuid').eq('email', customerEmail);
      const { data: riderProfile } = await riderQuery.maybeSingle();
      if (riderProfile) return this.creditRiderWallet(admin, riderProfile.uuid, args);

      const driverQuery = receiverAccountNumber
        ? admin.from('driver_profile').select('uuid').eq('wallet_account', receiverAccountNumber)
        : admin.from('driver_profile').select('uuid').eq('email', customerEmail);
      const { data: driverProfile } = await driverQuery.maybeSingle();
      if (driverProfile) return this.creditDriverWallet(admin, driverProfile.uuid, args);

      this.logger.warn(`No rider or driver profile matches transaction: ${receiverAccountNumber ?? customerEmail}`);
      this.fail(404, 'Profile not found for transaction');
    });
  }

  private async getUser(authorization: string) {
    const { data: { user }, error: userError } = await this.supabase.forUser(authorization).auth.getUser();
    if (userError || !user) this.fail(401, 'Invalid or expired session');
    return user;
  }

  private requireEnv(...names: string[]) {
    if (names.some((name) => !this.config.get<string>(name))) {
      throw new InternalServerErrorException('Server is misconfigured');
    }
  }

  private budpayAuthorization() {
    return `Bearer ${this.config.get<string>('BUDPAY_SECRET_KEY')}`;
  }

  private validWebhookSignature(signature?: string, rawBody?: Buffer) {
    const secret = this.config.get<string>('BUDPAY_SECRET_KEY');
    if (!signature || !rawBody || !secret) return false;
    const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
    const providedBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
  }

  private async execute(
    functionName: string,
    unexpectedMessage: string,
    action: () => Promise<PaymentsResponse>,
  ): Promise<PaymentsResponse> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof HttpException) {
        const response = error.getResponse();
        const message = typeof response === 'string'
          ? response
          : (response as { message?: string | string[] }).message;
        return this.result(error.getStatus(), {
          error: Array.isArray(message) ? (message[0] ?? error.message) : (message ?? error.message),
        });
      }
      this.logger.error(`${functionName} error: ${String(error)}`);
      return this.result(500, { error: unexpectedMessage });
    }
  }

  private fail(status: number, message: string): never {
    throw new HttpException(message, status);
  }

  private result(status: number, body: Record<string, any>): PaymentsResponse {
    return { status, body };
  }

  private async confirmRidePayment(admin: SupabaseClient, bookingId: string, args: CreditArgs): Promise<PaymentsResponse> {
    const { reference, verifiedData, creditedAmount, paidAt, payload } = args;
    const { data, error } = await admin.rpc('confirm_ride_payment', {
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
      this.logger.error(`Unable to confirm ride payment: ${JSON.stringify(error)}`);
      return this.result(500, { error: 'Unable to confirm ride payment' });
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
      await this.notifyDriverRideSettlement(admin, {
        bookingId,
        driverUuid: paymentResult.driverUuid,
        amount: Number(paymentResult.amount ?? creditedAmount),
      });
    }
    return this.result(200, paymentResult);
  }

  private async notifyDriverRideSettlement(
    admin: SupabaseClient,
    args: { bookingId: string; driverUuid: string; amount: number },
  ) {
    const { bookingId, driverUuid, amount } = args;
    const title = 'Ride payment received';
    const body = `Your wallet has been credited with ${this.formatNairaAmount(amount)} for booking ${bookingId.slice(0, 8)}.`;
    const { error: notificationInsertError } = await admin.from('notifications').insert({
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
      this.logger.error(`Unable to create driver settlement notification: ${JSON.stringify(notificationInsertError)}`);
    }

    const { data: driverProfile, error: driverError } = await admin
      .from('driver_profile')
      .select('uuid, first_name, expo_push_token, push_notification')
      .eq('uuid', driverUuid)
      .maybeSingle();
    if (driverError) {
      this.logger.error(`Unable to load driver push profile for settlement notification: ${JSON.stringify(driverError)}`);
      return;
    }
    if (!driverProfile?.push_notification || !this.isExpoPushToken(driverProfile.expo_push_token)) return;

    const expoResponse = await fetch(EXPO_PUSH_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
      },
      body: JSON.stringify([{
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
      }]),
    });
    if (!expoResponse.ok) {
      const expoResult = await expoResponse.json().catch(() => null);
      this.logger.warn(`Driver settlement push failed: ${JSON.stringify(expoResult)}`);
    }
  }

  private async creditRiderWallet(admin: SupabaseClient, riderUuid: string, args: CreditArgs): Promise<PaymentsResponse> {
    const { reference, verifiedData, creditedAmount, paidAt, payload } = args;
    const { error: insertError } = await admin.from('rider_transaction').insert({
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
      if (insertError.code === '23505') return this.result(200, { received: true, duplicate: true });
      this.logger.error(`Unable to record rider transaction: ${JSON.stringify(insertError)}`);
      return this.result(500, { error: 'Unable to record transaction' });
    }

    const { error: incrementError } = await admin.rpc('increment_wallet_balance', {
      p_rider_uuid: riderUuid,
      p_amount: creditedAmount,
    });
    if (incrementError) {
      this.logger.error(`Unable to increment rider wallet balance: ${JSON.stringify(incrementError)}`);
      return this.result(500, { error: 'Unable to update wallet balance' });
    }
    return this.result(200, { received: true });
  }

  private async creditDriverWallet(admin: SupabaseClient, driverUuid: string, args: CreditArgs): Promise<PaymentsResponse> {
    const { reference, verifiedData, creditedAmount, paidAt, payload } = args;
    const { error: insertError } = await admin.from('driver_transaction').insert({
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
      if (insertError.code === '23505') return this.result(200, { received: true, duplicate: true });
      this.logger.error(`Unable to record driver transaction: ${JSON.stringify(insertError)}`);
      return this.result(500, { error: 'Unable to record transaction' });
    }

    const { error: incrementError } = await admin.rpc('increment_driver_wallet_balance', {
      p_driver_uuid: driverUuid,
      p_amount: creditedAmount,
    });
    if (incrementError) {
      this.logger.error(`Unable to increment driver wallet balance: ${JSON.stringify(incrementError)}`);
      return this.result(500, { error: 'Unable to update wallet balance' });
    }
    return this.result(200, { received: true });
  }

  private async handlePayoutWebhook(admin: SupabaseClient, data: any, notifyType: string): Promise<PaymentsResponse> {
    const reference: string | undefined = data?.reference;
    if (!reference) this.fail(400, 'Missing payout reference');
    const nextStatus = notifyType === 'successful' ? 'success' : notifyType === 'failed' ? 'failed' : 'pending';
    const { data: updatedRows, error: updateError } = await admin
      .from('driver_transaction')
      .update({ status: nextStatus, raw_payload: data })
      .eq('reference', reference)
      .eq('status', 'pending')
      .select('id, driver_uuid, amount')
      .maybeSingle();
    if (updateError) {
      this.logger.error(`Unable to update driver payout status: ${JSON.stringify(updateError)}`);
      return this.result(500, { error: 'Unable to update payout status' });
    }

    if (updatedRows && nextStatus === 'failed') {
      const { error: refundError } = await admin.rpc('increment_driver_wallet_balance', {
        p_driver_uuid: updatedRows.driver_uuid,
        p_amount: Number(updatedRows.amount),
      });
      if (refundError) this.logger.error(`Unable to refund failed driver payout: ${JSON.stringify(refundError)}`);
    }
    return this.result(200, { received: true });
  }

  private isExpoPushToken(value: string | null) {
    return value ? /^Expo(nent)?PushToken\[.+\]$/.test(value) : false;
  }

  private formatNairaAmount(amount: number) {
    return `NGN ${Math.round(amount).toLocaleString('en-NG')}`;
  }
}
