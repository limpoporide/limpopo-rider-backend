import { BadGatewayException, HttpException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const TERMII_BASE_URL = 'https://v4.api.termii.com';
export const OTP_LENGTH = 6;

@Injectable()
export class TermiiService {
  private readonly logger = new Logger(TermiiService.name);

  constructor(private readonly config: ConfigService) {}

  private get apiKey() {
    const key = this.config.get<string>('TERMII_API_KEY');

    if (!key) {
      throw new InternalServerErrorException('OTP service is not configured');
    }

    return key;
  }

  /** Sends an OTP and returns the Termii pinId. `phone` must be E.164 (with +). */
  async sendOtp(phone: string, messageText: string): Promise<string> {
    const response = await fetch(`${TERMII_BASE_URL}/api/sms/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        message_type: 'NUMERIC',
        to: phone.replace(/^\+/, ''),
        from: this.config.get<string>('TERMII_SENDER_ID') ?? 'OE Alert',
        channel: this.config.get<string>('TERMII_OTP_CHANNEL') ?? 'dnd',
        pin_attempts: 3,
        pin_time_to_live: 5,
        pin_length: OTP_LENGTH,
        pin_placeholder: '< 123456 >',
        message_text: messageText,
        pin_type: 'NUMERIC',
      }),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      this.logger.warn(`Termii send failed ${JSON.stringify(payload)}`);
      throw new HttpException(payload?.message ?? payload?.smsStatus ?? 'Unable to send OTP right now.', response.status);
    }

    const pinId =
      typeof payload?.pinId === 'string' ? payload.pinId : typeof payload?.pin_id === 'string' ? payload.pin_id : '';

    if (!pinId) {
      throw new BadGatewayException('We could not start verification right now. Please try again.');
    }

    return pinId;
  }

  async verifyOtp(pinId: string, pin: string): Promise<void> {
    const response = await fetch(`${TERMII_BASE_URL}/api/sms/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: this.apiKey, pin_id: pinId, pin }),
    });

    const payload = await response.json().catch(() => null);
    const isVerified = String(payload?.verified).toLowerCase() === 'true';

    if (!response.ok || !isVerified) {
      this.logger.warn(`Termii verify failed ${JSON.stringify(payload)}`);
      throw new HttpException(
        payload?.message ?? payload?.smsStatus ?? 'The OTP code is invalid or has expired.',
        response.ok ? 400 : response.status,
      );
    }
  }
}
