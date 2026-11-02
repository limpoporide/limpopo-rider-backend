import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BookingsModule } from './bookings/bookings.module';
import { PaymentsModule } from './payments/payments.module';
import { RiderAuthModule } from './rider-auth/rider-auth.module';
import { TripsModule } from './trips/trips.module';
import { CommonModule } from './common/common.module';
import { SupabaseModule } from './supabase/supabase.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), CommonModule, SupabaseModule, RiderAuthModule, PaymentsModule, BookingsModule, TripsModule],
})
export class AppModule {}
