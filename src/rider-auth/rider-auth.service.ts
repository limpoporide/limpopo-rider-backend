import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { ResetTokenService } from '../common/reset-token.service';
import { normalizePhoneNumber, toLocalPhoneNumber } from '../common/phone.util';
import { SupabaseService } from '../supabase/supabase.service';
import { TermiiService } from '../termii/termii.service';

const RESET_PURPOSE = 'rider-password-reset';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

@Injectable()
export class RiderAuthService {
  private readonly logger = new Logger(RiderAuthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly termii: TermiiService,
    private readonly resetTokens: ResetTokenService,
  ) {}

  async sendPhoneOtp(phone?: string) {
    return this.withUnexpectedError('send-phone-otp', 'Unexpected OTP delivery error', async () => {
      this.assertConfigured(['TERMII_API_KEY'], 'OTP service is not configured');
      const normalizedPhone = normalizePhoneNumber(phone);
      if (!normalizedPhone) throw new BadRequestException('A valid phone number is required');

      const pinId = await this.termii.sendOtp(normalizedPhone, 'Your Limpopo verification code is < 123456 >');
      return { success: true, pinId };
    });
  }

  async verifyPhoneOtp(pinIdInput?: string, pinInput?: string) {
    return this.withUnexpectedError('verify-phone-otp', 'Unexpected OTP verification error', async () => {
      this.assertConfigured(['TERMII_API_KEY'], 'OTP service is not configured');
      const pinId = pinIdInput?.trim() ?? '';
      const pin = pinInput?.trim() ?? '';
      if (!pinId) throw new BadRequestException('A valid OTP session is required');
      if (!/^\d{6}$/.test(pin)) throw new BadRequestException('Enter the 6-digit OTP code');

      await this.termii.verifyOtp(pinId, pin);
      return { success: true, verified: true };
    });
  }

  async createRiderAuthUser(body: Record<string, string | undefined>) {
    return this.withUnexpectedError('create-rider-auth-user', 'Unexpected rider account creation error', async () => {
      this.assertConfigured(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'], 'Server is misconfigured');
      const firstName = body.firstName?.trim() ?? '';
      const lastName = body.lastName?.trim() ?? '';
      const email = body.email?.trim().toLowerCase() ?? '';
      const phone = body.phone?.trim() ?? '';
      const password = body.password?.trim() ?? '';
      const normalizedPhone = normalizePhoneNumber(phone);

      if (firstName.length < 3) throw new BadRequestException('First name must be at least 3 characters');
      if (lastName.length < 3) throw new BadRequestException('Last name must be at least 3 characters');
      if (!email || !EMAIL_PATTERN.test(email)) throw new BadRequestException('A valid email is required');
      if (!normalizedPhone) throw new BadRequestException('A valid phone number is required');
      if (!/^\d{6}$/.test(password)) throw new BadRequestException('Password must be exactly 6 digits');

      const admin = this.supabase.admin;
      const { data: createdUser, error: createUserError } = await admin.auth.admin.createUser({
        email,
        phone: normalizedPhone,
        password,
        email_confirm: true,
        phone_confirm: true,
        user_metadata: {
          email,
          first_name: firstName,
          last_name: lastName,
          phone_num: phone,
          phone_verified: true,
        },
      });

      if (createUserError || !createdUser.user) {
        this.logger.warn(`[create-rider-auth-user] failed to create auth user: ${createUserError?.message}`);
        throw new BadRequestException(createUserError?.message ?? 'Unable to create rider auth user');
      }

      const riderUserId = createdUser.user.id;
      const { error: profileError } = await admin.from('rider_profile').upsert(
        {
          uuid: riderUserId,
          first_name: firstName,
          last_name: lastName,
          email,
          phone_num: phone,
          phone_verified: true,
          wallet_balance: 0,
          push_notification: true,
        },
        { onConflict: 'uuid' },
      );

      if (profileError) {
        this.logger.error(`[create-rider-auth-user] failed to create rider profile: ${profileError.message}`);
        const { error: rollbackError } = await admin.auth.admin.deleteUser(riderUserId);
        if (rollbackError) {
          this.logger.error(`[create-rider-auth-user] failed to rollback auth user after profile error: ${rollbackError.message}`);
        }
        throw new InternalServerErrorException(profileError.message || 'Unable to create rider profile');
      }

      return { success: true, userId: riderUserId };
    });
  }

  async recoverRiderAuthUser(body: RecoveryRequest | null, authorization?: string) {
    return this.withUnexpectedError('recover-rider-auth-user', 'Unexpected rider auth recovery error', async () => {
      if (!authorization) throw new UnauthorizedException('Missing authorization header');
      this.assertConfigured(
        ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
        'Server is misconfigured',
      );

      const {
        data: { user: callerUser },
        error: callerError,
      } = await this.supabase.forUser(authorization).auth.getUser();
      if (callerError || !callerUser) throw new UnauthorizedException('Invalid or expired session');

      const oldUuid = body?.oldUuid?.trim();
      const temporaryPassword = body?.temporaryPassword?.trim();
      const snapshot = body?.profileSnapshot ?? {};
      if (!oldUuid) throw new BadRequestException('oldUuid is required');
      if (!temporaryPassword || !/^\d{6}$/.test(temporaryPassword)) {
        throw new BadRequestException('temporaryPassword must be exactly 6 digits');
      }

      const email = snapshot.email?.trim().toLowerCase();
      const normalizedPhone = normalizePhoneNumber(snapshot.phone_num);
      if (!email) throw new BadRequestException('profileSnapshot.email is required');
      if (!normalizedPhone) {
        throw new BadRequestException('profileSnapshot.phone_num must be a valid phone number');
      }

      const admin = this.supabase.admin;
      const { data: adminProfile, error: adminError } = await admin
        .from('admin_profile')
        .select('role, is_active')
        .eq('uuid', callerUser.id)
        .maybeSingle();
      if (adminError) {
        this.logger.error(`[recover-rider-auth-user] failed to load admin profile: ${adminError.message}`);
        throw new InternalServerErrorException('Unable to verify admin access');
      }
      if (!adminProfile?.is_active || adminProfile.role !== 'super-admin') {
        throw new ForbiddenException('Only active super-admins can recover rider auth users');
      }

      const { data: createdUser, error: createUserError } = await admin.auth.admin.createUser({
        email,
        phone: normalizedPhone,
        password: temporaryPassword,
        email_confirm: true,
        phone_confirm: snapshot.phone_verified ?? true,
        user_metadata: {
          first_name: snapshot.first_name?.trim() ?? '',
          last_name: snapshot.last_name?.trim() ?? '',
          phone_num: snapshot.phone_num?.trim() ?? normalizedPhone,
          phone_verified: snapshot.phone_verified ?? true,
        },
      });
      if (createUserError || !createdUser.user) {
        this.logger.warn(`[recover-rider-auth-user] failed to create replacement auth user: ${createUserError?.message}`);
        throw new BadRequestException(createUserError?.message ?? 'Unable to create replacement auth user');
      }

      const replacementUserId = createdUser.user.id;
      const recoveryPayload = {
        ...snapshot,
        email,
        phone_num: snapshot.phone_num?.trim() ?? normalizedPhone,
        phone_verified: snapshot.phone_verified ?? true,
        updated_at: snapshot.updated_at ?? new Date().toISOString(),
      };
      const { data: migrationResult, error: migrationError } = await admin.rpc('admin_recover_rider_account', {
        p_old_uuid: oldUuid,
        p_new_uuid: replacementUserId,
        p_profile: recoveryPayload,
      });
      if (migrationError) {
        this.logger.error(`[recover-rider-auth-user] rider data migration failed: ${migrationError.message}`);
        const { error: rollbackError } = await admin.auth.admin.deleteUser(replacementUserId);
        if (rollbackError) {
          this.logger.error(`[recover-rider-auth-user] failed to delete replacement auth user after migration error: ${rollbackError.message}`);
        }
        throw new InternalServerErrorException(migrationError.message || 'Unable to migrate rider data to replacement auth user');
      }

      return {
        success: true,
        oldUuid,
        newUuid: replacementUserId,
        migrated: migrationResult,
        nextStep: 'The rider can now log in with the temporary 6-digit password and should change it immediately in the app.',
      };
    });
  }

  async startRiderPasswordReset(phone?: string) {
    return this.withUnexpectedError('start-rider-password-reset', 'Unexpected password reset start error', async () => {
      this.assertConfigured(
        ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TERMII_API_KEY'],
        'Server is misconfigured',
      );
      const normalizedPhone = normalizePhoneNumber(phone);
      if (!normalizedPhone) throw new BadRequestException('A valid phone number is required');

      const localPhone = toLocalPhoneNumber(normalizedPhone);
      const { data: profile, error: profileError } = await this.supabase.admin
        .from('rider_profile')
        .select('uuid, phone_num')
        .eq('phone_num', localPhone)
        .maybeSingle<{ uuid: string; phone_num: string }>();
      if (profileError) {
        this.logger.error(`[start-rider-password-reset] profile lookup failed: ${profileError.message}`);
        throw new InternalServerErrorException('Unable to start password reset right now');
      }
      if (!profile?.uuid) throw new NotFoundException('No rider account exists for this phone number');

      const pinId = await this.termii.sendOtp(normalizedPhone, 'Your Limpopo password reset code is < 123456 >');
      return { success: true, pinId, phone: localPhone };
    });
  }

  async verifyRiderPasswordResetOtp(body: { phone?: string; pinId?: string; otp?: string }) {
    return this.withUnexpectedError(
      'verify-rider-password-reset-otp',
      'Unexpected password reset verification error',
      async () => {
        this.assertConfigured(['TERMII_API_KEY'], 'Server is misconfigured');
        this.assertResetSecret();
        const normalizedPhone = normalizePhoneNumber(body.phone);
        const pinId = body.pinId?.trim() ?? '';
        const otp = body.otp?.trim() ?? '';
        if (!normalizedPhone) throw new BadRequestException('A valid phone number is required');
        if (!pinId) throw new BadRequestException('A valid OTP session is required');
        if (!/^\d{6}$/.test(otp)) throw new BadRequestException('Enter the 6-digit OTP code');

        await this.termii.verifyOtp(pinId, otp);
        return { success: true, resetToken: this.resetTokens.issue(normalizedPhone, RESET_PURPOSE) };
      },
    );
  }

  async completeRiderPasswordReset(body: { phone?: string; resetToken?: string; password?: string }) {
    return this.withUnexpectedError(
      'complete-rider-password-reset',
      'Unexpected password reset completion error',
      async () => {
        this.assertConfigured(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'], 'Server is misconfigured');
        this.assertResetSecret();
        const normalizedPhone = normalizePhoneNumber(body.phone);
        const resetToken = body.resetToken?.trim() ?? '';
        const password = body.password?.trim() ?? '';
        if (!normalizedPhone) throw new BadRequestException('A valid phone number is required');
        if (!resetToken) throw new BadRequestException('A verified reset session is required');
        if (!/^\d{6}$/.test(password)) throw new BadRequestException('Create a 6-digit password to continue');

        const [encodedPayload, providedSignature] = resetToken.split('.');
        if (!encodedPayload || !providedSignature) {
          throw new BadRequestException('Reset session is invalid or expired');
        }
        this.assertRiderResetToken(encodedPayload, providedSignature, normalizedPhone);

        const localPhone = toLocalPhoneNumber(normalizedPhone);
        const admin = this.supabase.admin;
        const { data: profile, error: profileError } = await admin
          .from('rider_profile')
          .select('uuid')
          .eq('phone_num', localPhone)
          .maybeSingle<{ uuid: string }>();
        if (profileError) {
          this.logger.error(`[complete-rider-password-reset] profile lookup failed: ${profileError.message}`);
          throw new InternalServerErrorException('Unable to reset password right now');
        }
        if (!profile?.uuid) throw new NotFoundException('No rider account exists for this phone number');

        const { error: updateUserError } = await admin.auth.admin.updateUserById(profile.uuid, {
          password,
          phone_confirm: true,
          user_metadata: { phone_num: localPhone, phone_verified: true },
        });
        if (updateUserError) {
          this.logger.warn(`[complete-rider-password-reset] auth update failed: ${updateUserError.message}`);
          throw new BadRequestException(updateUserError.message ?? 'Unable to update password');
        }

        const { error: profileUpdateError } = await admin
          .from('rider_profile')
          .update({ phone_verified: true })
          .eq('uuid', profile.uuid);
        if (profileUpdateError) {
          this.logger.error(`[complete-rider-password-reset] profile update failed: ${profileUpdateError.message}`);
          throw new InternalServerErrorException('Password updated but profile sync failed');
        }

        return { success: true };
      },
    );
  }

  private assertConfigured(keys: string[], errorMessage: string) {
    if (keys.some((key) => !this.config.get<string>(key))) {
      throw new InternalServerErrorException(errorMessage);
    }
  }

  private assertResetSecret() {
    const secret = this.config.get<string>('PASSWORD_RESET_TOKEN_SECRET') ?? this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!secret) throw new InternalServerErrorException('Server is misconfigured');
  }

  private assertRiderResetToken(encodedPayload: string, providedSignature: string, phone: string) {
    const secret = this.config.get<string>('PASSWORD_RESET_TOKEN_SECRET') ?? this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const expectedSignature = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
    if (expectedSignature !== providedSignature) {
      throw new UnauthorizedException('Reset session is invalid or expired');
    }

    const decodedPayload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as {
      phone?: string;
      purpose?: string;
      exp?: number;
    };
    if (
      decodedPayload.purpose !== RESET_PURPOSE ||
      decodedPayload.phone !== phone ||
      typeof decodedPayload.exp !== 'number' ||
      decodedPayload.exp < Date.now()
    ) {
      throw new UnauthorizedException('Reset session is invalid or expired');
    }
  }

  private async withUnexpectedError<T>(name: string, message: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`[${name}] unexpected error`, error instanceof Error ? error.stack : String(error));
      throw new InternalServerErrorException(message);
    }
  }
}
