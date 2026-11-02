import { createClient } from 'npm:@supabase/supabase-js@2';

const TRACKING_POLL_INTERVAL_MS = 10000;
const LAST_VIEW_UPDATE_INTERVAL_MS = 60000;
const TERMINAL_RIDE_STATUSES = new Set(['completed', 'cancelled', 'expired']);

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const jsonResponse = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });

const htmlResponse = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

const sha256Hex = async (value: string) => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

const buildMapsUrl = (latitude: number | null, longitude: number | null, fallbackLabel: string) => {
  if (latitude !== null && longitude !== null) {
    return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
  }

  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fallbackLabel)}`;
};

const renderStateBadge = (rideStatus: string) => {
  switch (rideStatus) {
    case 'accepted':
      return 'Pilot on the way';
    case 'arrived':
      return 'Pilot has arrived';
    case 'in_progress':
      return 'Trip in progress';
    case 'completed':
      return 'Trip completed';
    case 'cancelled':
      return 'Trip cancelled';
    case 'expired':
      return 'Share expired';
    default:
      return 'Trip update';
  }
};

const renderTrackingPage = (token: string, initialPayload: Record<string, unknown>) => {
  const safeToken = encodeURIComponent(token);
  const initialJson = JSON.stringify(initialPayload).replaceAll('<', '\\u003c');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Limpopo Trip Tracking</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f1e8;
        --card: #fffdf8;
        --border: #e2d8c5;
        --text: #1f1a14;
        --muted: #6d6456;
        --accent: #c58b00;
        --accent-strong: #8a6100;
        --danger: #b63b2f;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        background: radial-gradient(circle at top, #fff9ee 0%, var(--bg) 60%, #eee4d3 100%);
        color: var(--text);
      }
      .shell {
        max-width: 720px;
        margin: 0 auto;
        min-height: 100vh;
        padding: 24px 16px 32px;
      }
      .hero {
        background: linear-gradient(135deg, #1d1a12, #6e5200);
        color: #ffffff;
        border-radius: 24px;
        padding: 20px;
        box-shadow: 0 18px 40px rgba(50, 34, 0, 0.22);
      }
      .eyebrow {
        font-size: 12px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        opacity: 0.72;
      }
      .headline {
        margin: 10px 0 6px;
        font-size: 28px;
        line-height: 1.1;
        font-weight: 800;
      }
      .subcopy {
        margin: 0;
        font-size: 14px;
        line-height: 1.5;
        opacity: 0.86;
      }
      .grid {
        display: grid;
        gap: 14px;
        margin-top: 18px;
      }
      .card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 16px;
        box-shadow: 0 10px 24px rgba(31, 26, 20, 0.08);
      }
      .label {
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .value {
        margin-top: 6px;
        font-size: 18px;
        line-height: 1.4;
        font-weight: 700;
      }
      .muted {
        color: var(--muted);
        font-size: 14px;
        line-height: 1.5;
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(197, 139, 0, 0.12);
        color: var(--accent-strong);
        font-weight: 700;
      }
      .actions {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-top: 18px;
      }
      .action-link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 46px;
        padding: 0 18px;
        border-radius: 999px;
        border: 1px solid var(--border);
        text-decoration: none;
        color: var(--text);
        background: #ffffff;
        font-weight: 700;
      }
      .action-link.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: #ffffff;
      }
      .error {
        color: var(--danger);
        font-weight: 700;
      }
      @media (max-width: 520px) {
        .headline { font-size: 24px; }
        .stats { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <div class="eyebrow">Limpopo live trip</div>
        <h1 class="headline" id="statusTitle">Loading trip status...</h1>
        <p class="subcopy" id="statusHint">This page refreshes automatically while the trip is active.</p>
      </section>

      <section class="grid">
        <div class="card">
          <div class="status-pill" id="statusPill">Checking status...</div>
          <p class="muted" id="updatedAtText" style="margin: 12px 0 0;">Preparing live updates...</p>
        </div>

        <div class="stats">
          <div class="card">
            <div class="label">Pilot</div>
            <div class="value" id="pilotName">--</div>
            <p class="muted" id="vehicleType">--</p>
          </div>
          <div class="card">
            <div class="label">Current ETA</div>
            <div class="value" id="etaValue">--</div>
            <p class="muted" id="distanceValue">--</p>
          </div>
        </div>

        <div class="card">
          <div class="label">Pickup</div>
          <div class="value" id="pickupValue">--</div>
        </div>

        <div class="card">
          <div class="label">Drop-off</div>
          <div class="value" id="dropoffValue">--</div>
        </div>

        <div class="card">
          <div class="label">Driver location</div>
          <div class="value" id="locationValue">Waiting for location...</div>
          <p class="muted" id="expiryText"></p>
          <div class="actions">
            <a id="mapsLink" class="action-link primary" target="_blank" rel="noreferrer">Open in Maps</a>
            <a id="refreshLink" class="action-link" href="?token=${safeToken}">Refresh page</a>
          </div>
        </div>

        <div class="card">
          <div class="label">Tracking notes</div>
          <p class="muted" id="footerNote">
            For privacy, this page exposes only the live trip state needed for tracking.
          </p>
        </div>
      </section>
    </main>

    <script>
      const initialPayload = ${initialJson};
      const jsonUrl = '?token=${safeToken}&format=json';
      const statusTitle = document.getElementById('statusTitle');
      const statusHint = document.getElementById('statusHint');
      const statusPill = document.getElementById('statusPill');
      const updatedAtText = document.getElementById('updatedAtText');
      const pilotName = document.getElementById('pilotName');
      const vehicleType = document.getElementById('vehicleType');
      const etaValue = document.getElementById('etaValue');
      const distanceValue = document.getElementById('distanceValue');
      const pickupValue = document.getElementById('pickupValue');
      const dropoffValue = document.getElementById('dropoffValue');
      const locationValue = document.getElementById('locationValue');
      const expiryText = document.getElementById('expiryText');
      const mapsLink = document.getElementById('mapsLink');

      const renderPayload = (payload) => {
        statusTitle.textContent = payload.statusTitle || 'Live trip update';
        statusHint.textContent = payload.statusHint || 'This page refreshes automatically while the trip is active.';
        statusPill.textContent = payload.statusLabel || 'Trip update';
        updatedAtText.textContent = payload.updatedAtLabel || 'Waiting for the next update...';
        pilotName.textContent = payload.pilotName || 'Pilot unavailable';
        vehicleType.textContent = payload.vehicleType || 'Vehicle details unavailable';
        etaValue.textContent = payload.etaText || '--';
        distanceValue.textContent = payload.distanceText || '--';
        pickupValue.textContent = payload.pickup || '--';
        dropoffValue.textContent = payload.dropoff || '--';
        locationValue.textContent = payload.locationText || 'Waiting for location...';
        expiryText.textContent = payload.expiryText || '';
        mapsLink.href = payload.mapsUrl || 'https://www.google.com/maps';
        if (payload.error) {
          statusHint.innerHTML = '<span class="error">' + payload.error + '</span>';
        }
      };

      const fetchUpdates = async () => {
        try {
          const response = await fetch(jsonUrl, {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          });
          const payload = await response.json();
          renderPayload(payload);
        } catch {
          statusHint.textContent = 'Live updates are temporarily unavailable. Pull to refresh or try again shortly.';
        }
      };

      renderPayload(initialPayload);
      window.setInterval(fetchUpdates, ${TRACKING_POLL_INTERVAL_MS});
    </script>
  </body>
</html>`;
};

const renderErrorPage = (message: string) => {
  const safeMessage = escapeHtml(message);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Limpopo Trip Tracking</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f6f1e8;
        color: #1f1a14;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        padding: 24px;
      }
      .card {
        max-width: 420px;
        background: #fffdf8;
        border: 1px solid #e2d8c5;
        border-radius: 20px;
        padding: 24px;
        text-align: center;
        box-shadow: 0 14px 30px rgba(31, 26, 20, 0.1);
      }
      h1 { margin: 0 0 12px; font-size: 24px; }
      p { margin: 0; line-height: 1.6; color: #6d6456; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Trip link unavailable</h1>
      <p>${safeMessage}</p>
    </div>
  </body>
</html>`;
};

const formatUpdatedAt = (isoValue: string | null) => {
  if (!isoValue) {
    return 'Waiting for a live update';
  }

  const parsedDate = new Date(isoValue);

  if (Number.isNaN(parsedDate.getTime())) {
    return 'Waiting for a live update';
  }

  return `Last updated ${parsedDate.toLocaleString('en-NG', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })}`;
};

const formatExpiry = (isoValue: string) => {
  const parsedDate = new Date(isoValue);

  if (Number.isNaN(parsedDate.getTime())) {
    return 'Share link expiry unavailable';
  }

  return `Share link expires ${parsedDate.toLocaleString('en-NG', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })}`;
};

const formatLocationText = (latitude: number | null, longitude: number | null) => {
  if (latitude === null || longitude === null) {
    return 'Pilot location will appear here once fresh coordinates are available.';
  }

  return `Current vehicle position: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
};

const buildPayload = (booking: Record<string, unknown>, driver: Record<string, unknown> | null, expiresAt: string) => {
  const rideStatus = typeof booking.ride_status === 'string' ? booking.ride_status : 'accepted';
  const pickup = typeof booking.pick_up === 'string' ? booking.pick_up : 'Pickup unavailable';
  const dropoff = typeof booking.drop_off === 'string' ? booking.drop_off : 'Drop-off unavailable';
  const totalKm = typeof booking.total_km === 'number' ? booking.total_km : null;
  const totalTime = typeof booking.total_time === 'number' ? booking.total_time : null;
  const pilotName = typeof driver?.first_name === 'string' && driver.first_name.trim() ? driver.first_name.trim() : 'Assigned pilot';
  const latitude = typeof driver?.location_lat === 'number' ? driver.location_lat : null;
  const longitude = typeof driver?.location_lng === 'number' ? driver.location_lng : null;

  return {
    status: rideStatus,
    statusLabel: renderStateBadge(rideStatus),
    statusTitle: TERMINAL_RIDE_STATUSES.has(rideStatus) ? 'This trip has ended' : 'Track this Limpopo trip live',
    statusHint: TERMINAL_RIDE_STATUSES.has(rideStatus)
      ? 'The shared ride has reached a terminal state. The final details remain visible until the link expires.'
      : 'This page refreshes automatically while the trip is active.',
    pilotName,
    vehicleType: typeof booking.vehicle_type === 'string' ? booking.vehicle_type : 'Vehicle unavailable',
    pickup,
    dropoff,
    etaText: totalTime !== null ? `${Math.max(1, Math.round(totalTime))} min` : '--',
    distanceText: totalKm !== null ? `${totalKm.toFixed(1)} km remaining` : '--',
    updatedAtLabel: formatUpdatedAt(typeof booking.updated_at === 'string' ? booking.updated_at : null),
    locationText: formatLocationText(latitude, longitude),
    mapsUrl: buildMapsUrl(latitude, longitude, TERMINAL_RIDE_STATUSES.has(rideStatus) ? dropoff : pickup),
    expiryText: formatExpiry(expiresAt),
    driverLocation: latitude !== null && longitude !== null ? { latitude, longitude } : null,
  };
};

Deno.serve(async (req: Request) => {
  if (req.method !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return jsonResponse(500, { error: 'Server is misconfigured' });
    }

    const url = new URL(req.url);
    const token = url.searchParams.get('token')?.trim() ?? '';
    const wantsJson = url.searchParams.get('format') === 'json' || req.headers.get('Accept')?.includes('application/json');

    if (!token) {
      return wantsJson
        ? jsonResponse(400, { error: 'Missing share token' })
        : htmlResponse(400, renderErrorPage('This trip link is incomplete.'));
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
    const tokenHash = await sha256Hex(token);
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('trip_share_session')
      .select('id, booking_id, share_status, expires_at, last_viewed_at')
      .eq('share_token_hash', tokenHash)
      .maybeSingle();

    if (sessionError) {
      console.log('[trip-share] session lookup failed', { sessionError });
      return wantsJson
        ? jsonResponse(500, { error: 'Unable to load trip share session' })
        : htmlResponse(500, renderErrorPage('We could not load this shared trip right now.'));
    }

    if (!session) {
      return wantsJson
        ? jsonResponse(404, { error: 'Trip share link not found' })
        : htmlResponse(404, renderErrorPage('This trip link does not exist or has already been revoked.'));
    }

    const expiresAtMs = Date.parse(session.expires_at);
    const isExpired = !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();

    if (session.share_status !== 'active' || isExpired) {
      if (session.share_status === 'active' && isExpired) {
        await supabaseAdmin
          .from('trip_share_session')
          .update({ share_status: 'expired' })
          .eq('id', session.id);
      }

      return wantsJson
        ? jsonResponse(410, { error: 'Trip share link has expired' })
        : htmlResponse(410, renderErrorPage('This trip link has expired. Ask the rider to share a new live-trip link.'));
    }

    const { data: booking, error: bookingError } = await supabaseAdmin
      .from('rider_booking')
      .select('id, assigned_driver, pick_up, drop_off, total_km, total_time, vehicle_type, ride_status, updated_at')
      .eq('id', session.booking_id)
      .maybeSingle();

    if (bookingError) {
      console.log('[trip-share] booking lookup failed', { bookingId: session.booking_id, bookingError });
      return wantsJson
        ? jsonResponse(500, { error: 'Unable to load booking details' })
        : htmlResponse(500, renderErrorPage('We could not load the live booking details.'));
    }

    if (!booking) {
      return wantsJson
        ? jsonResponse(404, { error: 'Booking not found' })
        : htmlResponse(404, renderErrorPage('This shared trip is no longer available.'));
    }

    const assignedDriverId = typeof booking.assigned_driver === 'string' ? booking.assigned_driver : '';
    const { data: driver } = assignedDriverId
      ? await supabaseAdmin
          .from('driver_profile')
          .select('first_name, location_lat, location_lng')
          .eq('uuid', assignedDriverId)
          .maybeSingle()
      : { data: null };

    const lastViewedAtMs = session.last_viewed_at ? Date.parse(session.last_viewed_at) : Number.NaN;

    if (!Number.isFinite(lastViewedAtMs) || Date.now() - lastViewedAtMs >= LAST_VIEW_UPDATE_INTERVAL_MS) {
      await supabaseAdmin
        .from('trip_share_session')
        .update({ last_viewed_at: new Date().toISOString() })
        .eq('id', session.id);
    }

    const payload = buildPayload(booking as Record<string, unknown>, (driver as Record<string, unknown> | null) ?? null, session.expires_at);

    if (wantsJson) {
      return jsonResponse(200, payload);
    }

    return htmlResponse(200, renderTrackingPage(token, payload));
  } catch (error) {
    console.log('[trip-share] unexpected error', error);
    return htmlResponse(500, renderErrorPage('An unexpected error interrupted live trip tracking.'));
  }
});