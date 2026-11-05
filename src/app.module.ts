import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { BookingsModule } from './bookings/bookings.module';
import { PaymentsModule } from './payments/payments.module';
import { RiderAuthModule } from './rider-auth/rider-auth.module';
import { TripsModule } from './trips/trips.module';
import { CommonModule } from './common/common.module';
import { HealthController } from './common/health.controller';
import { DEFAULT_LIMIT } from './common/throttle';
import { SupabaseModule } from './supabase/supabase.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([DEFAULT_LIMIT]),
    CommonModule,
    SupabaseModule,
    RiderAuthModule,
    PaymentsModule,
    BookingsModule,
    TripsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
