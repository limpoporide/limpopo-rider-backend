import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { RiderAuthService } from './rider-auth.service';
import { Throttle } from '@nestjs/throttler';
import { STRICT } from '../common/throttle';

@Controller()
export class RiderAuthController {
  constructor(private readonly auth: RiderAuthService) {}

  @Post('send-phone-otp')
  @HttpCode(200)
  @Throttle(STRICT)
  sendPhoneOtp(@Body() body: { phone?: string } | null) {
    return this.auth.sendPhoneOtp(body?.phone);
  }

  @Post('verify-phone-otp')
  @HttpCode(200)
  @Throttle(STRICT)
  verifyPhoneOtp(@Body() body: { pinId?: string; pin?: string } | null) {
    return this.auth.verifyPhoneOtp(body?.pinId, body?.pin);
  }

  @Post('create-rider-auth-user')
  @HttpCode(200)
  @Throttle(STRICT)
  createRiderAuthUser(@Body() body: Record<string, string | undefined> | null) {
    return this.auth.createRiderAuthUser(body ?? {});
  }

  @Post('recover-rider-auth-user')
  @HttpCode(200)
  @Throttle(STRICT)
  recoverRiderAuthUser(
    @Body() body: RecoveryRequest | null,
    @Headers('authorization') authorization?: string,
  ) {
    return this.auth.recoverRiderAuthUser(body, authorization);
  }

  @Post('start-rider-password-reset')
  @HttpCode(200)
  @Throttle(STRICT)
  startRiderPasswordReset(@Body() body: { phone?: string } | null) {
    return this.auth.startRiderPasswordReset(body?.phone);
  }

  @Post('verify-rider-password-reset-otp')
  @HttpCode(200)
  @Throttle(STRICT)
  verifyRiderPasswordResetOtp(
    @Body() body: { phone?: string; pinId?: string; otp?: string } | null,
  ) {
    return this.auth.verifyRiderPasswordResetOtp(body ?? {});
  }

  @Post('complete-rider-password-reset')
  @HttpCode(200)
  @Throttle(STRICT)
  completeRiderPasswordReset(
    @Body() body: { phone?: string; resetToken?: string; password?: string } | null,
  ) {
    return this.auth.completeRiderPasswordReset(body ?? {});
  }
}

type RecoveryProfileSnapshot = {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone_num?: string;
  phone_verified?: boolean;
  profile_img?: string | null;
  city?: string | null;
  state?: string | null;
  wallet_account?: string | null;
  wallet_balance?: number | string | null;
  account_name?: string | null;
  bank_name?: string | null;
  budpay_customer_code?: string | null;
  location_lat?: number | null;
  location_lng?: number | null;
  expo_push_token?: string | null;
  push_token_updated_at?: string | null;
  push_notification?: boolean;
  visibility?: boolean;
  created_at?: string;
  updated_at?: string;
};

type RecoveryRequest = {
  oldUuid?: string;
  temporaryPassword?: string;
  profileSnapshot?: RecoveryProfileSnapshot;
};
