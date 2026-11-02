import { Global, Module } from '@nestjs/common';
import { ResetTokenService } from './reset-token.service';

@Global()
@Module({ providers: [ResetTokenService], exports: [ResetTokenService] })
export class CommonModule {}
