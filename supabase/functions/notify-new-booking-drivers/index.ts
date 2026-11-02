import { createClient } from 'npm:@supabase/supabase-js@2';

const EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push/send';
const NEARBY_RADIUS_KM = 6;
const MAX_NEARBY_RECIPIENTS = 15;
const MAX_FALLBACK_RECIPIENTS = 40;
const DRIVER_NOTIFICATIONS_SCREEN = '/request/notifications';
const DRIVER_RIDE_REQUESTS_CHANNEL_ID = 'ride-requests-v2';
const DRIVER_RIDE_REQUESTS_SOUND = 'ping-ping.wav';

type BookingWebhookPayload = {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: 'schedule_booking' | 'rider_booking';
  schema: string;
  record: { id?: string } | null;
  old_record: Record<string, unknown> | null;
};

type ScheduleBookingRow = {
  id: string;
  schedule_type: 'ride' | 'hourly' | 'hire';
  booking_status: 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'converted';
  assigned_driver: string | null;
  pick_up: string;
  drop_off: string | null;
  pickup_lat: number | null;
  pickup_lng: number | null;
  schedule_date: string;
  pickup_time: string;
  total_fare: number;
};

type RiderBookingRow = {
  id: string;
  ride_status: 'open' | 'accepted' | 'arrived' | 'in_progress' | 'completed' | 'cancelled' | 'expired';
  assigned_driver: string | null;
  pick_up: string;
  drop_off: string;
  pickup_lat: number;
  pickup_lng: number;
  total_fare: number;
};

type DriverCandidate = {
  uuid: string;
  first_name: string;
  expo_push_token: string | null;
  location_lat: number | null;
  location_lng: number | null;
};

type NotificationContent = {
  title: string;
  body: string;
  pickupLat: number | null;
  pickupLng: number | null;
};

const jsonResponse = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const isExpoPushToken = (value: string | null) => {
  if (!value) {
    return false;
  }

  return /^Expo(nent)?PushToken\[.+\]$/.test(value);
};

const toRadians = (value: number) => (value * Math.PI) / 180;

const distanceKmBetween = (startLat: number, startLng: number, endLat: number, endLng: number) => {
  const earthRadiusKm = 6371;
  const deltaLat = toRadians(endLat - startLat);
  const deltaLng = toRadians(endLng - startLng);
  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(toRadians(startLat)) * Math.cos(toRadians(endLat)) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const buildScheduleLabel = (scheduleDate: string, pickupTime: string) => {
  const safeDate = scheduleDate.trim();
  const safeTime = pickupTime.trim();

  if (!safeDate) {
    return 'Scheduled ride';
  }

  if (!safeTime) {
    return safeDate;
  }

  return `${safeDate} at ${safeTime}`;
};

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return jsonResponse(500, { error: 'Server is misconfigured' });
    }

    const payload = (await req.json()) as BookingWebhookPayload;
    const bookingId = payload.record?.id;

    if (!bookingId || (payload.table !== 'schedule_booking' && payload.table !== 'rider_booking')) {
      return jsonResponse(400, { error: 'Missing or unsupported booking payload' });
    }

    if (payload.table === 'schedule_booking') {
      return jsonResponse(200, {
        skipped: 'schedule_booking_waiting_for_promotion',
        bookingId,
      });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
    let notification: NotificationContent | null = null;

    const { data: booking, error: bookingError } = await supabaseAdmin
      .from('rider_booking')
      .select('id, ride_status, assigned_driver, pick_up, drop_off, pickup_lat, pickup_lng, total_fare')
      .eq('id', bookingId)
      .maybeSingle<RiderBookingRow>();

    if (bookingError) {
      console.log('[notify-new-booking-drivers] rider_booking fetch failed', bookingError);
      return jsonResponse(500, { error: 'Unable to load rider booking' });
    }

    if (!booking || booking.ride_status !== 'open' || booking.assigned_driver) {
      return jsonResponse(200, { skipped: 'booking_not_eligible', bookingId });
    }

    notification = {
      title: 'New instant ride request',
      body: `${booking.pick_up} → ${booking.drop_off}`,
      pickupLat: booking.pickup_lat,
      pickupLng: booking.pickup_lng,
    };

    if (!notification) {
      return jsonResponse(200, { skipped: 'no_notification_content', bookingId });
    }

    const { data: drivers, error: driversError } = await supabaseAdmin
      .from('driver_profile')
      .select('uuid, first_name, expo_push_token, location_lat, location_lng')
      .eq('admin_verify', true)
      .eq('is_online', true)
      .eq('push_notification', true)
      .not('expo_push_token', 'is', null);

    if (driversError) {
      console.log('[notify-new-booking-drivers] driver fetch failed', driversError);
      return jsonResponse(500, { error: 'Unable to load driver candidates' });
    }

    const validDrivers = (drivers ?? []).filter((driver): driver is DriverCandidate => isExpoPushToken(driver.expo_push_token));

    if (validDrivers.length === 0) {
      return jsonResponse(200, { bookingId, notifiedDrivers: 0, skipped: 'no_online_drivers_with_tokens' });
    }

    const notificationContent = notification;

    const prioritizedNearbyDrivers =
      notificationContent.pickupLat == null || notificationContent.pickupLng == null
        ? []
        : validDrivers
            .map((driver) => {
              if (driver.location_lat == null || driver.location_lng == null) {
                return { driver, distanceKm: Number.POSITIVE_INFINITY };
              }

              return {
                driver,
                distanceKm: distanceKmBetween(
                  notificationContent.pickupLat as number,
                  notificationContent.pickupLng as number,
                  driver.location_lat,
                  driver.location_lng
                ),
              };
            })
            .filter((candidate) => Number.isFinite(candidate.distanceKm) && candidate.distanceKm <= NEARBY_RADIUS_KM)
            .sort((left, right) => left.distanceKm - right.distanceKm)
            .slice(0, MAX_NEARBY_RECIPIENTS)
            .map((candidate) => candidate.driver);

    const fallbackOnlineDrivers = validDrivers.filter(
      (driver) => !prioritizedNearbyDrivers.some((nearbyDriver) => nearbyDriver.uuid === driver.uuid)
    );

    const recipientDrivers = prioritizedNearbyDrivers.length > 0
      ? prioritizedNearbyDrivers
      : fallbackOnlineDrivers.slice(0, MAX_FALLBACK_RECIPIENTS);

    if (recipientDrivers.length === 0) {
      return jsonResponse(200, { bookingId, notifiedDrivers: 0, skipped: 'no_eligible_recipients' });
    }

    const notificationRows = recipientDrivers.map((driver) => ({
      recipient_id: driver.uuid,
      recipient_role: 'driver' as const,
      type: 'booking_request',
      title: notificationContent.title,
      body: notificationContent.body,
      data: { bookingId, source: payload.table, screen: DRIVER_NOTIFICATIONS_SCREEN },
    }));

    const { error: notificationInsertError } = await supabaseAdmin
      .from('notifications')
      .insert(notificationRows);

    if (notificationInsertError) {
      console.log('[notify-new-booking-drivers] notification insert failed', notificationInsertError);
    }

    const messages = recipientDrivers.map((driver) => ({
      to: driver.expo_push_token,
      title: notificationContent.title,
      body: notificationContent.body,
      sound: DRIVER_RIDE_REQUESTS_SOUND,
      priority: 'high',
      channelId: DRIVER_RIDE_REQUESTS_CHANNEL_ID,
      data: {
        bookingId,
        source: payload.table,
        screen: DRIVER_NOTIFICATIONS_SCREEN,
      },
    }));

    const expoResponse = await fetch(EXPO_PUSH_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
      },
      body: JSON.stringify(messages),
    });

    const expoResult = await expoResponse.json();

    if (!expoResponse.ok) {
      console.log('[notify-new-booking-drivers] expo push send failed', expoResult);
      return jsonResponse(502, { error: 'Expo push send failed', details: expoResult });
    }

    console.log('[notify-new-booking-drivers] notification batch sent', {
      bookingId,
      table: payload.table,
      nearbyRecipients: prioritizedNearbyDrivers.length,
      fallbackRecipients: prioritizedNearbyDrivers.length > 0 ? 0 : recipientDrivers.length,
      totalRecipients: recipientDrivers.length,
    });

    return jsonResponse(200, {
      bookingId,
      table: payload.table,
      notifiedDrivers: recipientDrivers.length,
      nearbyRecipients: prioritizedNearbyDrivers.length,
      usedFallbackOnlineDrivers: prioritizedNearbyDrivers.length === 0,
      expoResult,
    });
  } catch (error) {
    console.log('[notify-new-booking-drivers] unexpected error', error);
    return jsonResponse(500, { error: 'Unexpected notification error' });
  }
});
