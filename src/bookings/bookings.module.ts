import { Module } from '@nestjs/common';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { TripCompletionService } from './trip-completion.service';

@Module({ controllers: [BookingsController], providers: [BookingsService, TripCompletionService] })
export class BookingsModule {}
