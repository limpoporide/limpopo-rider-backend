import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private adminClient?: SupabaseClient;

  constructor(private readonly config: ConfigService) {}

  /** Service-role client. Never expose it to callers. */
  get admin(): SupabaseClient {
    if (!this.adminClient) {
      const url = this.config.get<string>('SUPABASE_URL');
      const key = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');

      if (!url || !key) {
        throw new InternalServerErrorException('Server is misconfigured');
      }

      this.adminClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    }

    return this.adminClient;
  }

  /** Client scoped to the caller's JWT so RLS applies. */
  forUser(authorization: string | undefined): SupabaseClient {
    const url = this.config.get<string>('SUPABASE_URL');
    const key = this.config.get<string>('SUPABASE_ANON_KEY');

    if (!url || !key) {
      throw new InternalServerErrorException('Server is misconfigured');
    }

    return createClient(url, key, {
      global: { headers: { Authorization: authorization ?? '' } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
}
