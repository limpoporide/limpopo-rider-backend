import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';

const EXPO = 'https://exp.host/--/api/v2/push/send';
const RIDER_SCREEN = '/notifications';
const DRIVER_SCREEN = '/request/notifications';
const isExpoToken = (token: string | null | undefined) => !!token && /^Expo(nent)?PushToken\[.+\]$/.test(token);
const asRecord = (value: unknown): Record<string, any> => value !== null && typeof value === 'object' ? value as Record<string, any> : {};

export type EndpointResponse = { status: number; body: Record<string, unknown> };
const result = (status: number, body: Record<string, unknown>): EndpointResponse => ({ status, body });

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(private readonly config: ConfigService, private readonly supabase: SupabaseService) {}

  private configured(anon = false) {
    return !!this.config.get('SUPABASE_URL') && !!this.config.get('SUPABASE_SERVICE_ROLE_KEY') &&
      (!anon || !!this.config.get('SUPABASE_ANON_KEY'));
  }

  async notifyNewBookingDrivers(input: unknown): Promise<EndpointResponse> {
    try {
      if (!this.configured()) return result(500, { error: 'Server is misconfigured' });
      const payload = asRecord(input);
      const bookingId = payload.record?.id;
      if (!bookingId || !['schedule_booking', 'rider_booking'].includes(payload.table)) return result(400, { error: 'Missing or unsupported booking payload' });
      if (payload.table === 'schedule_booking') return result(200, { skipped: 'schedule_booking_waiting_for_promotion', bookingId });
      const admin = this.supabase.admin;
      const { data: booking, error: bookingError } = await admin.from('rider_booking')
        .select('id, ride_status, assigned_driver, pick_up, drop_off, pickup_lat, pickup_lng, total_fare').eq('id', bookingId).maybeSingle();
      if (bookingError) { this.logger.warn(`[notify-new-booking-drivers] rider_booking fetch failed ${JSON.stringify(bookingError)}`); return result(500, { error: 'Unable to load rider booking' }); }
      if (!booking || booking.ride_status !== 'open' || booking.assigned_driver) return result(200, { skipped: 'booking_not_eligible', bookingId });
      const notification = { title: 'New instant ride request', body: `${booking.pick_up} → ${booking.drop_off}`, lat: booking.pickup_lat, lng: booking.pickup_lng };
      const { data: drivers, error: driversError } = await admin.from('driver_profile')
        .select('uuid, first_name, expo_push_token, location_lat, location_lng').eq('admin_verify', true).eq('is_online', true)
        .eq('push_notification', true).not('expo_push_token', 'is', null);
      if (driversError) { this.logger.warn(`[notify-new-booking-drivers] driver fetch failed ${JSON.stringify(driversError)}`); return result(500, { error: 'Unable to load driver candidates' }); }
      const valid = (drivers ?? []).filter((driver: Record<string, any>) => isExpoToken(driver.expo_push_token));
      if (!valid.length) return result(200, { bookingId, notifiedDrivers: 0, skipped: 'no_online_drivers_with_tokens' });
      const radians = (value: number) => value * Math.PI / 180;
      const distance = (a: number, b: number, c: number, d: number) => {
        const lat = radians(c - a); const lng = radians(d - b);
        const h = Math.sin(lat / 2) ** 2 + Math.cos(radians(a)) * Math.cos(radians(c)) * Math.sin(lng / 2) ** 2;
        return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
      };
      const nearby = notification.lat == null || notification.lng == null ? [] : valid
        .map((driver: Record<string, any>) => ({ driver, distance: driver.location_lat == null || driver.location_lng == null
          ? Number.POSITIVE_INFINITY : distance(notification.lat, notification.lng, driver.location_lat, driver.location_lng) }))
        .filter((entry: { distance: number }) => Number.isFinite(entry.distance) && entry.distance <= 6)
        .sort((a: { distance: number }, b: { distance: number }) => a.distance - b.distance).slice(0, 15)
        .map((entry: { driver: Record<string, any> }) => entry.driver);
      const fallback = valid.filter((driver: Record<string, any>) => !nearby.some((near: Record<string, any>) => near.uuid === driver.uuid));
      const recipients = nearby.length ? nearby : fallback.slice(0, 40);
      if (!recipients.length) return result(200, { bookingId, notifiedDrivers: 0, skipped: 'no_eligible_recipients' });
      const pushData = { bookingId, source: payload.table, screen: DRIVER_SCREEN };
      const { error: insertError } = await admin.from('notifications').insert(recipients.map((driver: Record<string, any>) => ({
        recipient_id: driver.uuid, recipient_role: 'driver', type: 'booking_request', title: notification.title, body: notification.body, data: pushData,
      })));
      if (insertError) this.logger.warn(`[notify-new-booking-drivers] notification insert failed ${JSON.stringify(insertError)}`);
      const response = await fetch(EXPO, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' },
        body: JSON.stringify(recipients.map((driver: Record<string, any>) => ({ to: driver.expo_push_token, title: notification.title,
          body: notification.body, sound: 'ping-ping.wav', priority: 'high', channelId: 'ride-requests-v2', data: pushData }))) });
      const expoResult: unknown = await response.json();
      if (!response.ok) { this.logger.warn(`[notify-new-booking-drivers] expo push send failed ${JSON.stringify(expoResult)}`); return result(502, { error: 'Expo push send failed', details: expoResult }); }
      this.logger.log(`[notify-new-booking-drivers] notification batch sent ${JSON.stringify({ bookingId, table: payload.table,
        nearbyRecipients: nearby.length, fallbackRecipients: nearby.length ? 0 : recipients.length, totalRecipients: recipients.length })}`);
      return result(200, { bookingId, table: payload.table, notifiedDrivers: recipients.length, nearbyRecipients: nearby.length,
        usedFallbackOnlineDrivers: nearby.length === 0, expoResult });
    } catch (error) { this.logger.error('[notify-new-booking-drivers] unexpected error', error); return result(500, { error: 'Unexpected notification error' }); }
  }

  async notifyRiderBookingStatus(input: unknown): Promise<EndpointResponse> {
    try {
      if (!this.configured()) return result(500, { error: 'Server is misconfigured' });
      const payload = asRecord(input); const booking = payload.record;
      const bookingId = booking?.id ?? ''; const riderId = booking?.uuid ?? booking?.rider_id ?? '';
      const status = payload.table === 'schedule_booking' ? booking?.booking_status ?? '' : booking?.ride_status ?? '';
      const previous = payload.table === 'schedule_booking' ? payload.old_record?.booking_status ?? '' : payload.old_record?.ride_status ?? '';
      if (!bookingId || !riderId || !['rider_booking', 'schedule_booking'].includes(payload.table)) return result(400, { error: 'Missing or unsupported booking payload' });
      const eligible = payload.table === 'schedule_booking' ? ['confirmed'] : ['accepted', 'arrived', 'in_progress', 'completed'];
      if (status === previous || !eligible.includes(status)) return result(200, { skipped: 'status_not_eligible', bookingId, status });
      const { data: rider, error } = await this.supabase.admin.from('rider_profile').select('uuid, first_name, expo_push_token, push_notification').eq('uuid', riderId).maybeSingle();
      if (error) { this.logger.warn(`[notify-rider-booking-status] rider fetch failed ${JSON.stringify(error)}`); return result(500, { error: 'Unable to load rider profile' }); }
      if (!rider) return result(404, { error: 'Rider profile not found', bookingId, riderId });
      const pickup = booking?.pick_up ?? ''; const dropoff = booking?.drop_off ?? ''; const p = pickup.trim(); const d = dropoff.trim();
      const body = status === 'arrived' ? 'Please meet your Pilot. Your 5 minute arrival window has started.'
        : status === 'in_progress' ? 'Please fasten your seat belt' : status === 'completed' ? 'Thank you for riding with Limpopo Ride.'
          : p && d ? `${p} -> ${d}` : 'Your driver is on the way to your pickup location.';
      const content = payload.table === 'schedule_booking' ? { title: 'Driver assigned to your scheduled ride', statusKey: 'bookingStatus' }
        : status === 'arrived' ? { title: 'Your Pilot has arrived', statusKey: 'rideStatus' }
          : status === 'in_progress' ? { title: 'Enjoy your Trip using Limpopo Ride', statusKey: 'rideStatus' }
            : status === 'completed' ? { title: 'You have arrived at your Destination', statusKey: 'rideStatus' }
              : { title: 'Pilot accepted your ride', statusKey: 'rideStatus' };
      if (!rider.push_notification || !isExpoToken(rider.expo_push_token)) return result(200, { bookingId, riderId, status, skipped: 'push_disabled_or_missing_token' });
      const response = await fetch(EXPO, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' },
        body: JSON.stringify([{ to: rider.expo_push_token, title: content.title, body, sound: 'default', priority: 'high', channelId: 'ride-updates',
          data: { bookingId, source: payload.table, [content.statusKey]: status, screen: RIDER_SCREEN } }]) });
      const expoResult: Record<string, any> = await response.json();
      if (!response.ok) { this.logger.warn(`[notify-rider-booking-status] expo push send failed ${JSON.stringify(expoResult)}`); return result(502, { error: 'Expo push send failed', details: expoResult }); }
      const ticket = (Array.isArray(expoResult?.data) ? expoResult.data : []).find((item: Record<string, any>) => item?.status === 'error');
      if (ticket) { this.logger.warn(`[notify-rider-booking-status] expo push ticket error ${JSON.stringify({ bookingId, riderId, status, ticket })}`); return result(502, { bookingId, riderId, status, error: 'Expo push ticket error', details: ticket }); }
      this.logger.log(`[notify-rider-booking-status] push sent ${JSON.stringify({ bookingId, riderId, status })}`);
      return result(200, { bookingId, riderId, status, expoResult });
    } catch (error) { this.logger.error('[notify-rider-booking-status] unexpected error', error); return result(500, { error: 'Unexpected notification error' }); }
  }

  async notifyRiderScheduledBookingCreated(input: unknown): Promise<EndpointResponse> {
    try {
      if (!this.configured()) return result(500, { error: 'Server is misconfigured' });
      const bodyInput = asRecord(input); const bookingId = typeof bodyInput.bookingId === 'string' ? bodyInput.bookingId.trim() : '';
      if (!bookingId) return result(400, { error: 'Missing bookingId' });
      const admin = this.supabase.admin;
      const { data: booking, error: bookingError } = await admin.from('schedule_booking').select('id, rider_id, pick_up, drop_off, booking_status').eq('id', bookingId).maybeSingle();
      if (bookingError) { this.logger.warn(`[notify-rider-scheduled-booking-created] booking fetch failed ${JSON.stringify(bookingError)}`); return result(500, { error: 'Unable to load scheduled booking' }); }
      if (!booking) return result(404, { error: 'Scheduled booking not found' });
      const { data: rider, error: riderError } = await admin.from('rider_profile').select('uuid, first_name, expo_push_token, push_notification').eq('uuid', booking.rider_id).maybeSingle();
      if (riderError) { this.logger.warn(`[notify-rider-scheduled-booking-created] rider fetch failed ${JSON.stringify(riderError)}`); return result(500, { error: 'Unable to load rider profile' }); }
      if (!rider) return result(404, { error: 'Rider profile not found' });
      const pickup = booking.pick_up.trim(); const dropoff = booking.drop_off?.trim() ?? '';
      const message = pickup && dropoff ? `${pickup} → ${dropoff}` : pickup || 'We will start looking for a pilot 2 hours before your pickup time.';
      if (!rider.push_notification || !isExpoToken(rider.expo_push_token)) return result(200, { bookingId: booking.id, skipped: 'push_disabled_or_missing_token' });
      const response = await fetch(EXPO, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' },
        body: JSON.stringify([{ to: rider.expo_push_token, title: 'Your booking has been registered', body: message, sound: 'default', priority: 'high', channelId: 'ride-updates',
          data: { bookingId: booking.id, source: 'schedule_booking', bookingStatus: booking.booking_status, screen: RIDER_SCREEN } }]) });
      const expoResult: unknown = await response.json();
      if (!response.ok) { this.logger.warn(`[notify-rider-scheduled-booking-created] expo push send failed ${JSON.stringify(expoResult)}`); return result(502, { error: 'Expo push send failed', details: expoResult }); }
      return result(200, { bookingId: booking.id, riderId: booking.rider_id, delivered: true });
    } catch (error) { this.logger.error('[notify-rider-scheduled-booking-created] unexpected error', error); return result(500, { error: 'Unexpected server error' }); }
  }

  async promoteScheduledBookings(input: unknown): Promise<EndpointResponse> {
    try {
      if (!this.configured()) return result(500, { error: 'Server is misconfigured' });
      const value = asRecord(input).leadTimeHours; const requested = typeof value === 'number' ? value : 2;
      const hours = Number.isFinite(requested) ? Math.min(24, Math.max(1, requested)) : 2;
      const { data, error } = await this.supabase.admin.rpc('promote_due_scheduled_bookings', { p_lead_time: `${hours} hours` });
      if (error) { this.logger.warn(`[promote-scheduled-bookings] promotion failed ${JSON.stringify(error)}`); return result(500, { error: 'Unable to promote scheduled bookings' }); }
      const promotions = Array.isArray(data) ? data : [];
      return result(200, { promotedCount: promotions.length, promotions });
    } catch (error) { this.logger.error('[promote-scheduled-bookings] unexpected error', error); return result(500, { error: 'Unexpected server error' }); }
  }

  async expireStaleRiderBookings(input: unknown): Promise<EndpointResponse> {
    try {
      if (!this.configured()) return result(500, { error: 'Server is misconfigured' });
      const value = asRecord(input).expiryMinutes; const requested = typeof value === 'number' ? value : 2;
      const minutes = Number.isFinite(requested) ? Math.min(60, Math.max(1, requested)) : 2;
      const { data, error } = await this.supabase.admin.rpc('expire_stale_open_rider_bookings', { p_expiry: `${minutes} minutes` });
      if (error) { this.logger.warn(`[expire-stale-rider-bookings] expiry failed ${JSON.stringify(error)}`); return result(500, { error: 'Unable to expire stale rider bookings' }); }
      const expired = Array.isArray(data) ? data : [];
      return result(200, { expiredCount: expired.length, bookingIds: expired.map((row: Record<string, any>) => row.booking_id) });
    } catch (error) { this.logger.error('[expire-stale-rider-bookings] unexpected error', error); return result(500, { error: 'Unexpected server error' }); }
  }

  async manageRiderNotifications(input: unknown, authorization?: string): Promise<EndpointResponse> {
    try {
      if (!authorization) return result(401, { error: 'Missing authorization header' });
      if (!this.configured(true)) return result(500, { error: 'Server is misconfigured' });
      const { data: { user }, error } = await this.supabase.forUser(authorization).auth.getUser();
      if (error || !user) return result(401, { error: 'Invalid or expired session' });
      const body = asRecord(input); const action = body.action;
      const notificationId = body.notificationId?.trim();
      if (action !== 'delete' && action !== 'clear') return result(400, { error: 'action must be delete or clear' });
      if (action === 'delete' && !notificationId) return result(400, { error: 'notificationId is required for delete' });
      let query = this.supabase.admin.from('notifications').delete().eq('recipient_id', user.id).eq('recipient_role', 'rider');
      if (action === 'delete' && notificationId) query = query.eq('id', notificationId);
      const { error: deleteError } = await query;
      if (deleteError) { this.logger.warn(`[manage-rider-notifications] delete failed ${JSON.stringify({ action, notificationId: notificationId ?? null, riderId: user.id, deleteError })}`); return result(500, { error: 'Unable to delete notification(s)' }); }
      return result(200, { success: true, action, notificationId: notificationId ?? null });
    } catch (error) { this.logger.error('[manage-rider-notifications] unexpected error', error); return result(500, { error: 'Unexpected notification management error' }); }
  }

  async manageDriverNotifications(input: unknown, authorization?: string): Promise<EndpointResponse> {
    try {
      if (!authorization) return result(401, { error: 'Missing authorization header' });
      if (!this.configured(true)) return result(500, { error: 'Server is misconfigured' });
      const { data: { user }, error } = await this.supabase.forUser(authorization).auth.getUser();
      if (error || !user) return result(401, { error: 'Invalid or expired session' });
      const body = asRecord(input); const notificationId = body.notificationId?.trim() ?? '';
      if (body.action !== 'delete' || !notificationId) return result(400, { error: 'action=delete and notificationId are required' });
      const { error: deleteError } = await this.supabase.admin.from('notifications').delete().eq('id', notificationId).eq('recipient_id', user.id).eq('recipient_role', 'driver');
      if (deleteError) { this.logger.warn(`[manage-driver-notifications] delete failed ${JSON.stringify({ notificationId, driverId: user.id, deleteError })}`); return result(500, { error: 'Unable to delete notification' }); }
      return result(200, { success: true, action: 'delete', notificationId });
    } catch (error) { this.logger.error('[manage-driver-notifications] unexpected error', error); return result(500, { error: 'Unexpected notification management error' }); }
  }
}
