import { Module } from '@nestjs/common';
import { TermiiModule } from '../termii/termii.module';
import { RiderAuthController } from './rider-auth.controller';
import { RiderAuthService } from './rider-auth.service';

@Module({
  imports: [TermiiModule],
  controllers: [RiderAuthController],
  providers: [RiderAuthService],
})
export class RiderAuthModule {}
