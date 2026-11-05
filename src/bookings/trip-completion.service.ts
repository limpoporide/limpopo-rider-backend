import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';

export type TripCompletionResponse = { status: number; body: Record<string, unknown> };

const reply = (status: number, body: Record<string, unknown>): TripCompletionResponse => ({
  status,
  body,
});

@Injectable()
export class TripCompletionService {
  private readonly logger = new Logger(TripCompletionService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {}

  async completeTrip(input: unknown, authorization?: string): Promise<TripCompletionResponse> {
    try {
      if (!authorization) {
        return reply(401, { error: 'Missing authorization header' });
      }

      const configured =
        this.config.get('SUPABASE_URL') &&
        this.config.get('SUPABASE_ANON_KEY') &&
        this.config.get('SUPABASE_SERVICE_ROLE_KEY');

      if (!configured) {
        return reply(500, { error: 'Server is misconfigured' });
      }

      const {
        data: { user },
        error: userError,
      } = await this.supabase.forUser(authorization).auth.getUser();

      if (userError || !user) {
        return reply(401, { error: 'Invalid or expired session' });
      }

      const body = (input ?? {}) as { bookingId?: string; reason?: string };
      const bookingId = typeof body.bookingId === 'string' ? body.bookingId.trim() : '';
      const reason = typeof body.reason === 'string' ? body.reason.trim() : null;

      if (!bookingId) {
        return reply(400, { error: 'bookingId is required' });
      }

      const admin = this.supabase.admin;
      const { data: booking, error: bookingError } = await admin
        .from('rider_booking')
        .select('id, assigned_driver, ride_status, trip_completed_at')
        .eq('id', bookingId)
        .maybeSingle();

      if (bookingError) {
        this.logger.warn(
          `[complete-rider-trip] failed to load booking ${JSON.stringify({ bookingId, driverId: user.id, bookingError })}`,
        );
        return reply(500, { error: 'Unable to load booking details' });
      }

      if (!booking) {
        return reply(404, { error: 'Booking not found' });
      }

      if (booking.assigned_driver !== user.id) {
        return reply(403, { error: 'You are not assigned to this booking' });
      }

      if (booking.ride_status === 'completed') {
        return reply(200, {
          success: true,
          status: 'already_completed',
          rideStatus: booking.ride_status,
          tripCompletedAt: booking.trip_completed_at,
          reason,
        });
      }

      if (booking.ride_status !== 'in_progress') {
        return reply(409, { error: 'Trip must be in progress before it can be completed' });
      }

      const { data: updated, error: updateError } = await admin
        .from('rider_booking')
        .update({ ride_status: 'completed', trip_completed_at: new Date().toISOString() })
        .eq('id', bookingId)
        .eq('assigned_driver', user.id)
        .eq('ride_status', 'in_progress')
        .select('id, ride_status, trip_completed_at')
        .maybeSingle();

      if (updateError) {
        this.logger.warn(
          `[complete-rider-trip] failed to update booking ${JSON.stringify({ bookingId, driverId: user.id, reason, updateError })}`,
        );
        return reply(500, { error: 'Unable to complete trip' });
      }

      if (!updated) {
        // Another request may have completed the trip between our read and update.
        const { data: current, error: currentError } = await admin
          .from('rider_booking')
          .select('ride_status, trip_completed_at')
          .eq('id', bookingId)
          .maybeSingle();

        if (currentError) {
          this.logger.warn(
            `[complete-rider-trip] failed to reload booking ${JSON.stringify({ bookingId, driverId: user.id, reason, currentError })}`,
          );
          return reply(500, { error: 'Unable to confirm trip completion' });
        }

        if (current?.ride_status === 'completed') {
          return reply(200, {
            success: true,
            status: 'already_completed',
            rideStatus: current.ride_status,
            tripCompletedAt: current.trip_completed_at,
            reason,
          });
        }

        return reply(409, { error: 'Trip could not be completed from its current state' });
      }

      return reply(200, {
        success: true,
        status: 'completed',
        rideStatus: updated.ride_status,
        tripCompletedAt: updated.trip_completed_at,
        reason,
      });
    } catch (error) {
      this.logger.error('[complete-rider-trip] unexpected error', error);
      return reply(500, { error: 'Unexpected trip completion error' });
    }
  }
}
