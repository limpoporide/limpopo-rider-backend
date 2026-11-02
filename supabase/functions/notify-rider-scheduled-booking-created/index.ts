import { createClient } from 'npm:@supabase/supabase-js@2';

const EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push/send';
const RIDER_NOTIFICATIONS_SCREEN = '/notifications';

type ScheduleBookingRow = {
  id: string;
  rider_id: string;
  pick_up: string;
  drop_off: string | null;
  booking_status: string;
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

const buildNotificationBody = (pickup: string, dropoff: string | null) => {
  const pickupLabel = pickup.trim();
  const dropoffLabel = dropoff?.trim() ?? '';

  if (pickupLabel && dropoffLabel) {
    return `${pickupLabel} → ${dropoffLabel}`;
  }

  if (pickupLabel) {
    return pickupLabel;
  }

  return 'We will start looking for a pilot 2 hours before your pickup time.';
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

    const body = await req.json().catch(() => ({}));
    const bookingId = typeof body?.bookingId === 'string' ? body.bookingId.trim() : '';

    if (!bookingId) {
      return jsonResponse(400, { error: 'Missing bookingId' });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
    const { data: booking, error: bookingError } = await supabaseAdmin
      .from('schedule_booking')
      .select('id, rider_id, pick_up, drop_off, booking_status')
      .eq('id', bookingId)
      .maybeSingle<ScheduleBookingRow>();

    if (bookingError) {
      console.log('[notify-rider-scheduled-booking-created] booking fetch failed', bookingError);
      return jsonResponse(500, { error: 'Unable to load scheduled booking' });
    }

    if (!booking) {
      return jsonResponse(404, { error: 'Scheduled booking not found' });
    }

    const { data: rider, error: riderError } = await supabaseAdmin
      .from('rider_profile')
      .select('uuid, first_name, expo_push_token, push_notification')
      .eq('uuid', booking.rider_id)
      .maybeSingle<RiderPushProfile>();

    if (riderError) {
      console.log('[notify-rider-scheduled-booking-created] rider fetch failed', riderError);
      return jsonResponse(500, { error: 'Unable to load rider profile' });
    }

    if (!rider) {
      return jsonResponse(404, { error: 'Rider profile not found' });
    }

    const title = 'Your booking has been registered';
    const bodyText = buildNotificationBody(booking.pick_up, booking.drop_off);

    if (!rider.push_notification || !isExpoPushToken(rider.expo_push_token)) {
      return jsonResponse(200, { bookingId: booking.id, skipped: 'push_disabled_or_missing_token' });
    }

    const expoResponse = await fetch(EXPO_PUSH_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
      },
      body: JSON.stringify([
        {
          to: rider.expo_push_token,
          title,
          body: bodyText,
          sound: 'default',
          priority: 'high',
          channelId: 'ride-updates',
          data: {
            bookingId: booking.id,
            source: 'schedule_booking',
            bookingStatus: booking.booking_status,
            screen: RIDER_NOTIFICATIONS_SCREEN,
          },
        },
      ]),
    });

    const expoResult = await expoResponse.json();

    if (!expoResponse.ok) {
      console.log('[notify-rider-scheduled-booking-created] expo push send failed', expoResult);
      return jsonResponse(502, { error: 'Expo push send failed', details: expoResult });
    }

    return jsonResponse(200, {
      bookingId: booking.id,
      riderId: booking.rider_id,
      delivered: true,
    });
  } catch (error) {
    console.log('[notify-rider-scheduled-booking-created] unexpected error', error);
    return jsonResponse(500, { error: 'Unexpected server error' });
  }
});