import { Injectable, InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

const RESET_TOKEN_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class ResetTokenService {
  constructor(private readonly config: ConfigService) {}

  private get secret() {
    const secret = this.config.get<string>('PASSWORD_RESET_TOKEN_SECRET') || this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');

    if (!secret) {
      throw new InternalServerErrorException('Server is misconfigured');
    }

    return secret;
  }

  private sign(payload: string) {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  issue(phone: string, purpose: string) {
    const payload = Buffer.from(JSON.stringify({ phone, purpose, exp: Date.now() + RESET_TOKEN_TTL_MS })).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  /** Throws 400/401 with the same messages as the original edge function. */
  assertValid(token: string, phone: string, purpose: string) {
    const [payload, signature] = token.split('.');

    if (!payload || !signature) {
      throw new UnauthorizedException('Reset session is invalid or expired');
    }

    const expected = Buffer.from(this.sign(payload));
    const provided = Buffer.from(signature);

    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new UnauthorizedException('Reset session is invalid or expired');
    }

    let decoded: { phone?: string; purpose?: string; exp?: number };

    try {
      decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw new UnauthorizedException('Reset session is invalid or expired');
    }

    if (decoded.purpose !== purpose || decoded.phone !== phone || typeof decoded.exp !== 'number' || decoded.exp < Date.now()) {
      throw new UnauthorizedException('Reset session is invalid or expired');
    }
  }
}
