import { createClient } from 'npm:@supabase/supabase-js@2';

const EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push/send';
const RIDER_NOTIFICATIONS_SCREEN = '/notifications';

type BookingStatusWebhookPayload = {
  type: 'UPDATE';
  table: 'rider_booking' | 'schedule_booking';
  schema: string;
  record: {
    id?: string;
    uuid?: string;
    rider_id?: string;
    assigned_driver?: string | null;
    pick_up?: string;
    drop_off?: string;
    ride_status?: string;
    booking_status?: string;
  } | null;
  old_record: {
    ride_status?: string;
    booking_status?: string;
  } | null;
};

type RiderPushProfile = {
  uuid: string;
  first_name: string;
  expo_push_token: string | null;
  push_notification: boolean;
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

const resolveNotificationBody = (status: string, pickup: string, dropoff: string) => {
  if (status === 'arrived') {
    return 'Please meet your Pilot. Your 5 minute arrival window has started.';
  }

  if (status === 'in_progress') {
    return 'Please fasten your seat belt';
  }

  if (status === 'completed') {
    return 'Thank you for riding with Limpopo Ride.';
  }

  const pickupLabel = pickup.trim();
  const dropoffLabel = dropoff.trim();

  if (pickupLabel && dropoffLabel) {
    return `${pickupLabel} -> ${dropoffLabel}`;
  }

  return 'Your driver is on the way to your pickup location.';
};

const resolveNotificationContent = (
  table: BookingStatusWebhookPayload['table'],
  status: string,
  pickup: string,
  dropoff: string
) => {
  if (table === 'schedule_booking') {
    return {
      type: 'schedule_booking_confirmed',
      title: 'Driver assigned to your scheduled ride',
      body: resolveNotificationBody(status, pickup, dropoff),
      statusKey: 'bookingStatus',
    } as const;
  }

  if (status === 'arrived') {
    return {
      type: 'driver_arrived',
      title: 'Your Pilot has arrived',
      body: resolveNotificationBody(status, pickup, dropoff),
      statusKey: 'rideStatus',
    } as const;
  }

  if (status === 'in_progress') {
    return {
      type: 'trip_started',
      title: 'Enjoy your Trip using Limpopo Ride',
      body: resolveNotificationBody(status, pickup, dropoff),
      statusKey: 'rideStatus',
    } as const;
  }

  if (status === 'completed') {
    return {
      type: 'trip_completed',
      title: 'You have arrived at your Destination',
      body: resolveNotificationBody(status, pickup, dropoff),
      statusKey: 'rideStatus',
    } as const;
  }

  return {
    type: 'ride_accepted',
    title: 'Pilot accepted your ride',
    body: resolveNotificationBody(status, pickup, dropoff),
    statusKey: 'rideStatus',
  } as const;
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

    const payload = (await req.json()) as BookingStatusWebhookPayload;
    const bookingRecord = payload.record;
    const bookingId = bookingRecord?.id ?? '';
    const riderId = bookingRecord?.uuid ?? bookingRecord?.rider_id ?? '';
    const nextStatus = payload.table === 'schedule_booking'
      ? bookingRecord?.booking_status ?? ''
      : bookingRecord?.ride_status ?? '';
    const previousStatus = payload.table === 'schedule_booking'
      ? payload.old_record?.booking_status ?? ''
      : payload.old_record?.ride_status ?? '';

    if (!bookingId || !riderId || (payload.table !== 'rider_booking' && payload.table !== 'schedule_booking')) {
      return jsonResponse(400, { error: 'Missing or unsupported booking payload' });
    }

    const eligibleStatuses = payload.table === 'schedule_booking'
      ? ['confirmed']
      : ['accepted', 'arrived', 'in_progress', 'completed'];

    if (nextStatus === previousStatus || !eligibleStatuses.includes(nextStatus)) {
      return jsonResponse(200, { skipped: 'status_not_eligible', bookingId, status: nextStatus });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const { data: rider, error: riderError } = await supabaseAdmin
      .from('rider_profile')
      .select('uuid, first_name, expo_push_token, push_notification')
      .eq('uuid', riderId)
      .maybeSingle<RiderPushProfile>();

    if (riderError) {
      console.log('[notify-rider-booking-status] rider fetch failed', riderError);
      return jsonResponse(500, { error: 'Unable to load rider profile' });
    }

    if (!rider) {
      return jsonResponse(404, { error: 'Rider profile not found', bookingId, riderId });
    }

    const notificationContent = resolveNotificationContent(
      payload.table,
      nextStatus,
      bookingRecord?.pick_up ?? '',
      bookingRecord?.drop_off ?? ''
    );

    if (!rider.push_notification || !isExpoPushToken(rider.expo_push_token)) {
      return jsonResponse(200, { bookingId, riderId, status: nextStatus, skipped: 'push_disabled_or_missing_token' });
    }

    const expoPayload = [
      {
        to: rider.expo_push_token,
        title: notificationContent.title,
        body: notificationContent.body,
        sound: 'default',
        priority: 'high',
        channelId: 'ride-updates',
        data: {
          bookingId,
          source: payload.table,
          [notificationContent.statusKey]: nextStatus,
          screen: RIDER_NOTIFICATIONS_SCREEN,
        },
      },
    ];

    const expoResponse = await fetch(EXPO_PUSH_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
      },
      body: JSON.stringify(expoPayload),
    });

    const expoResult = await expoResponse.json();

    if (!expoResponse.ok) {
      console.log('[notify-rider-booking-status] expo push send failed', expoResult);
      return jsonResponse(502, { error: 'Expo push send failed', details: expoResult });
    }

    // Expo returns HTTP 200 even when an individual push ticket fails, so check ticket status too.
    const tickets = Array.isArray(expoResult?.data) ? expoResult.data : [];
    const failedTicket = tickets.find((ticket: { status?: string }) => ticket?.status === 'error');

    if (failedTicket) {
      console.log('[notify-rider-booking-status] expo push ticket error', {
        bookingId,
        riderId,
        status: nextStatus,
        ticket: failedTicket,
      });
      return jsonResponse(502, { bookingId, riderId, status: nextStatus, error: 'Expo push ticket error', details: failedTicket });
    }

    console.log('[notify-rider-booking-status] push sent', {
      bookingId,
      riderId,
      status: nextStatus,
    });

    return jsonResponse(200, {
      bookingId,
      riderId,
      status: nextStatus,
      expoResult,
    });
  } catch (error) {
    console.log('[notify-rider-booking-status] unexpected error', error);
    return jsonResponse(500, { error: 'Unexpected notification error' });
  }
});
