import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { RtcRole, RtcTokenBuilder } from 'agora-token';
import { SupabaseService } from '../supabase/supabase.service';

const ACTIVE_SHARE_HOURS = 12;
const COMPLETED_SHARE_HOURS = 1;
const SHAREABLE_STATUSES = new Set(['accepted', 'arrived', 'in_progress', 'completed']);
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'expired']);
const response = (
  status: number,
  body: Record<string, unknown> | string,
  headers: Record<string, string> = {},
): TripEndpointResponse => ({ status, body, headers });
const objectValue = (value: unknown): Record<string, any> =>
  value !== null && typeof value === 'object' ? (value as Record<string, any>) : {};
const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

export type TripEndpointResponse = {
  status: number;
  body: Record<string, unknown> | string;
  headers: Record<string, string>;
};

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {}

  private configured(anon = false) {
    return (
      !!this.config.get('SUPABASE_URL') &&
      !!this.config.get('SUPABASE_SERVICE_ROLE_KEY') &&
      (!anon || !!this.config.get('SUPABASE_ANON_KEY'))
    );
  }

  private get supabaseUrl() {
    return this.config.get<string>('SUPABASE_URL')!;
  }

  async createTripShareLink(input: unknown, authorization?: string): Promise<TripEndpointResponse> {
    try {
      if (!authorization) return response(401, { error: 'Missing authorization header' });
      if (!this.configured(true)) return response(500, { error: 'Server is misconfigured' });
      const {
        data: { user },
        error: userError,
      } = await this.supabase.forUser(authorization).auth.getUser();
      if (userError || !user) return response(401, { error: 'Invalid or expired session' });
      const body = objectValue(input);
      const bookingId = body.bookingId?.trim() ?? '';
      const viewerLabel = body.viewerLabel?.trim() || null;
      const createdFrom = body.createdFrom?.trim() || 'rider_accept_screen';
      if (!bookingId) return response(400, { error: 'bookingId is required' });
      const caller = this.supabase.forUser(authorization);
      const { data: booking, error: bookingError } = await caller
        .from('rider_booking')
        .select('id, rider_id, assigned_driver, ride_status')
        .eq('id', bookingId)
        .maybeSingle();
      if (bookingError) {
        this.logger.warn(
          `[create-trip-share-link] booking lookup failed ${JSON.stringify({ bookingId, bookingError })}`,
        );
        return response(500, { error: 'Unable to load booking' });
      }
      if (!booking || booking.rider_id !== user.id)
        return response(404, { error: 'Booking not found' });
      if (!SHAREABLE_STATUSES.has(booking.ride_status))
        return response(400, { error: 'This trip is not currently shareable' });
      if (!booking.assigned_driver)
        return response(400, {
          error: 'A live trip link becomes available after a pilot is assigned',
        });
      const expiresAt = new Date(
        Date.now() +
          (booking.ride_status === 'completed' ? COMPLETED_SHARE_HOURS : ACTIVE_SHARE_HOURS) *
            60 *
            60 *
            1000,
      ).toISOString();
      const shareToken = `${randomUUID()}${randomBytes(32).toString('hex')}`;
      const admin = this.supabase.admin;
      const { error: revokeError } = await admin
        .from('trip_share_session')
        .update({ share_status: 'revoked' })
        .eq('booking_id', bookingId)
        .eq('rider_id', user.id)
        .eq('share_status', 'active');
      if (revokeError) {
        this.logger.warn(
          `[create-trip-share-link] revoke failed ${JSON.stringify({ bookingId, riderId: user.id, revokeError })}`,
        );
        return response(500, { error: 'Unable to reset previous share links' });
      }
      const { data: session, error: insertError } = await admin
        .from('trip_share_session')
        .insert({
          booking_id: bookingId,
          rider_id: user.id,
          share_token_hash: sha256Hex(shareToken),
          share_status: 'active',
          expires_at: expiresAt,
          viewer_label: viewerLabel,
          created_from: createdFrom,
        })
        .select('id, share_status, expires_at')
        .maybeSingle();
      if (insertError) {
        this.logger.warn(
          `[create-trip-share-link] insert failed ${JSON.stringify({ bookingId, riderId: user.id, insertError })}`,
        );
        return response(500, { error: 'Unable to create share link' });
      }
      const shareUrl = `${this.supabaseUrl.replace(/\/$/, '')}/functions/v1/trip-share?token=${encodeURIComponent(shareToken)}`;
      return response(200, {
        shareUrl,
        sessionId: session?.id ?? null,
        shareStatus: session?.share_status ?? 'active',
        expiresAt: session?.expires_at ?? expiresAt,
      });
    } catch (error) {
      this.logger.error('[create-trip-share-link] unexpected error', error);
      return response(500, { error: 'Unexpected trip share error' });
    }
  }

  async createAgoraCallToken(
    input: unknown,
    authorization?: string,
  ): Promise<TripEndpointResponse> {
    try {
      if (!authorization) return response(401, { error: 'Missing authorization header' });
      const body = objectValue(input);
      const bookingId = typeof body.bookingId === 'string' ? body.bookingId.trim() : '';
      if (!bookingId) return response(400, { error: 'bookingId is required' });
      if (!this.configured(true)) return response(500, { error: 'Server is misconfigured' });
      const appId = this.config.get<string>('AGORA_APP_ID');
      const certificate = this.config.get<string>('AGORA_APP_CERTIFICATE');
      if (!appId || !certificate)
        return response(500, { error: 'Agora secrets are not configured on the server' });
      const {
        data: { user },
        error: userError,
      } = await this.supabase.forUser(authorization).auth.getUser();
      if (userError || !user) return response(401, { error: 'Invalid or expired session' });
      const { data: booking, error: bookingError } = await this.supabase.admin
        .from('rider_booking')
        .select('id, rider_id, assigned_driver, ride_status')
        .eq('id', bookingId)
        .maybeSingle();
      if (bookingError || !booking) return response(404, { error: 'Booking not found' });
      if (booking.rider_id !== user.id && booking.assigned_driver !== user.id)
        return response(403, { error: 'You are not allowed to join this call' });
      if (!booking.assigned_driver)
        return response(409, { error: 'A driver must be assigned before starting a call' });
      const channelName = `ride-${bookingId}`.slice(0, 64);
      const uid = this.hashUid(user.id);
      const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
      const token = RtcTokenBuilder.buildTokenWithUid(
        appId,
        certificate,
        channelName,
        uid,
        RtcRole.PUBLISHER,
        expiresAt,
        expiresAt,
      );
      return response(200, { appId, channelName, token, uid, expiresAt });
    } catch (error) {
      this.logger.error('create-agora-call-token error', error);
      return response(500, { error: 'Unexpected error creating Agora call token' });
    }
  }

  private hashUid(value: string) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1)
      hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
    return Math.max(1, hash);
  }

  async tripShare(
    tokenInput?: string,
    format?: string,
    accept?: string,
  ): Promise<TripEndpointResponse> {
    const wantsJson = format === 'json' || !!accept?.includes('application/json');
    try {
      if (!this.configured())
        return response(500, { error: 'Server is misconfigured' }, { 'Cache-Control': 'no-store' });
      const token = tokenInput?.trim() ?? '';
      if (!token)
        return wantsJson
          ? response(400, { error: 'Missing share token' }, { 'Cache-Control': 'no-store' })
          : this.htmlError(400, 'This trip link is incomplete.');
      const admin = this.supabase.admin;
      const { data: session, error: sessionError } = await admin
        .from('trip_share_session')
        .select('id, booking_id, share_status, expires_at, last_viewed_at')
        .eq('share_token_hash', sha256Hex(token))
        .maybeSingle();
      if (sessionError) {
        this.logger.warn(`[trip-share] session lookup failed ${JSON.stringify({ sessionError })}`);
        return wantsJson
          ? response(
              500,
              { error: 'Unable to load trip share session' },
              { 'Cache-Control': 'no-store' },
            )
          : this.htmlError(500, 'We could not load this shared trip right now.');
      }
      if (!session)
        return wantsJson
          ? response(404, { error: 'Trip share link not found' }, { 'Cache-Control': 'no-store' })
          : this.htmlError(404, 'This trip link does not exist or has already been revoked.');
      const expiresAt = Date.parse(session.expires_at);
      const expired = !Number.isFinite(expiresAt) || expiresAt <= Date.now();
      if (session.share_status !== 'active' || expired) {
        if (session.share_status === 'active' && expired)
          await admin
            .from('trip_share_session')
            .update({ share_status: 'expired' })
            .eq('id', session.id);
        return wantsJson
          ? response(410, { error: 'Trip share link has expired' }, { 'Cache-Control': 'no-store' })
          : this.htmlError(
              410,
              'This trip link has expired. Ask the rider to share a new live-trip link.',
            );
      }
      const { data: booking, error: bookingError } = await admin
        .from('rider_booking')
        .select(
          'id, assigned_driver, pick_up, drop_off, total_km, total_time, vehicle_type, ride_status, updated_at',
        )
        .eq('id', session.booking_id)
        .maybeSingle();
      if (bookingError) {
        this.logger.warn(
          `[trip-share] booking lookup failed ${JSON.stringify({ bookingId: session.booking_id, bookingError })}`,
        );
        return wantsJson
          ? response(
              500,
              { error: 'Unable to load booking details' },
              { 'Cache-Control': 'no-store' },
            )
          : this.htmlError(500, 'We could not load the live booking details.');
      }
      if (!booking)
        return wantsJson
          ? response(404, { error: 'Booking not found' }, { 'Cache-Control': 'no-store' })
          : this.htmlError(404, 'This shared trip is no longer available.');
      const driverId = typeof booking.assigned_driver === 'string' ? booking.assigned_driver : '';
      const { data: driver } = driverId
        ? await admin
            .from('driver_profile')
            .select('first_name, location_lat, location_lng')
            .eq('uuid', driverId)
            .maybeSingle()
        : { data: null };
      const viewedAt = session.last_viewed_at ? Date.parse(session.last_viewed_at) : Number.NaN;
      if (!Number.isFinite(viewedAt) || Date.now() - viewedAt >= 60000)
        await admin
          .from('trip_share_session')
          .update({ last_viewed_at: new Date().toISOString() })
          .eq('id', session.id);
      const payload = this.buildPayload(booking, driver, session.expires_at);
      return wantsJson
        ? response(200, payload, { 'Cache-Control': 'no-store' })
        : response(200, this.renderTrackingPage(token, payload), {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
    } catch (error) {
      this.logger.error('[trip-share] unexpected error', error);
      return this.htmlError(500, 'An unexpected error interrupted live trip tracking.');
    }
  }

  private buildPayload(
    booking: Record<string, any>,
    driver: Record<string, any> | null,
    expiresAt: string,
  ) {
    const status = typeof booking.ride_status === 'string' ? booking.ride_status : 'accepted';
    const pickup = typeof booking.pick_up === 'string' ? booking.pick_up : 'Pickup unavailable';
    const dropoff =
      typeof booking.drop_off === 'string' ? booking.drop_off : 'Drop-off unavailable';
    const totalKm = typeof booking.total_km === 'number' ? booking.total_km : null;
    const totalTime = typeof booking.total_time === 'number' ? booking.total_time : null;
    const pilotName =
      typeof driver?.first_name === 'string' && driver.first_name.trim()
        ? driver.first_name.trim()
        : 'Assigned pilot';
    const latitude = typeof driver?.location_lat === 'number' ? driver.location_lat : null;
    const longitude = typeof driver?.location_lng === 'number' ? driver.location_lng : null;
    const lastUpdated = this.formatDate(
      typeof booking.updated_at === 'string' ? booking.updated_at : null,
      'Waiting for a live update',
      'Last updated ',
    );
    const expiry = this.formatDate(
      expiresAt,
      'Share link expiry unavailable',
      'Share link expires ',
    );
    const labels: Record<string, string> = {
      accepted: 'Pilot on the way',
      arrived: 'Pilot has arrived',
      in_progress: 'Trip in progress',
      completed: 'Trip completed',
      cancelled: 'Trip cancelled',
      expired: 'Share expired',
    };
    const terminal = TERMINAL_STATUSES.has(status);
    return {
      status,
      statusLabel: labels[status] ?? 'Trip update',
      statusTitle: terminal ? 'This trip has ended' : 'Track this Limpopo trip live',
      statusHint: terminal
        ? 'The shared ride has reached a terminal state. The final details remain visible until the link expires.'
        : 'This page refreshes automatically while the trip is active.',
      pilotName,
      vehicleType:
        typeof booking.vehicle_type === 'string' ? booking.vehicle_type : 'Vehicle unavailable',
      pickup,
      dropoff,
      etaText: totalTime !== null ? `${Math.max(1, Math.round(totalTime))} min` : '--',
      distanceText: totalKm !== null ? `${totalKm.toFixed(1)} km remaining` : '--',
      updatedAtLabel: lastUpdated,
      locationText:
        latitude === null || longitude === null
          ? 'Pilot location will appear here once fresh coordinates are available.'
          : `Current vehicle position: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`,
      mapsUrl:
        latitude !== null && longitude !== null
          ? `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`
          : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(terminal ? dropoff : pickup)}`,
      expiryText: expiry,
      driverLocation: latitude !== null && longitude !== null ? { latitude, longitude } : null,
    };
  }

  private formatDate(value: string | null, fallback: string, prefix: string) {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return fallback;
    return `${prefix}${date.toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`;
  }

  private renderTrackingPage(token: string, payload: Record<string, unknown>) {
    const safeToken = encodeURIComponent(token);
    const initialJson = JSON.stringify(payload).replaceAll('<', '\\u003c');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Limpopo Trip Tracking</title>
<style>body{margin:0;background:#f6f1e8;color:#1f1a14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.shell{max-width:720px;margin:auto;padding:24px 16px}.hero{background:linear-gradient(135deg,#1d1a12,#6e5200);color:white;border-radius:24px;padding:20px}.grid{display:grid;gap:14px;margin-top:18px}.card{background:#fffdf8;border:1px solid #e2d8c5;border-radius:18px;padding:16px}.label{font-size:12px;text-transform:uppercase;color:#6d6456}.value{margin-top:6px;font-size:18px;font-weight:700}.muted{color:#6d6456;line-height:1.5}.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}@media(max-width:520px){.stats{grid-template-columns:1fr}}</style></head>
<body><main class="shell"><section class="hero"><div>LIMPOPO LIVE TRIP</div><h1 id="statusTitle">Loading trip status...</h1><p id="statusHint">This page refreshes automatically while the trip is active.</p></section>
<section class="grid"><div class="card"><strong id="statusPill">Checking status...</strong><p class="muted" id="updatedAtText">Preparing live updates...</p></div><div class="stats">
<div class="card"><div class="label">Pilot</div><div class="value" id="pilotName">--</div><p class="muted" id="vehicleType">--</p></div><div class="card"><div class="label">Current ETA</div><div class="value" id="etaValue">--</div><p class="muted" id="distanceValue">--</p></div></div>
<div class="card"><div class="label">Pickup</div><div class="value" id="pickupValue">--</div></div><div class="card"><div class="label">Drop-off</div><div class="value" id="dropoffValue">--</div></div>
<div class="card"><div class="label">Driver location</div><div class="value" id="locationValue">Waiting for location...</div><p class="muted" id="expiryText"></p><a id="mapsLink" target="_blank" rel="noreferrer">Open in Maps</a> · <a href="?token=${safeToken}">Refresh page</a></div>
<div class="card"><div class="label">Tracking notes</div><p class="muted">For privacy, this page exposes only the live trip state needed for tracking.</p></div></section></main>
<script>const initialPayload=${initialJson};const jsonUrl='?token=${safeToken}&format=json';const fields={statusTitle:'statusTitle',statusHint:'statusHint',statusPill:'statusLabel',updatedAtText:'updatedAtLabel',pilotName:'pilotName',vehicleType:'vehicleType',etaValue:'etaText',distanceValue:'distanceText',pickupValue:'pickup',dropoffValue:'dropoff',locationValue:'locationText',expiryText:'expiryText'};const render=p=>{for(const [id,key] of Object.entries(fields)){const el=document.getElementById(id);if(el)el.textContent=p[key]||''}document.getElementById('mapsLink').href=p.mapsUrl||'https://www.google.com/maps'};const update=async()=>{try{const r=await fetch(jsonUrl,{headers:{Accept:'application/json'},cache:'no-store'});render(await r.json())}catch{document.getElementById('statusHint').textContent='Live updates are temporarily unavailable. Pull to refresh or try again shortly.'}};render(initialPayload);window.setInterval(update,10000);</script></body></html>`;
  }

  private htmlError(status: number, message: string): TripEndpointResponse {
    const safe = message
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Limpopo Trip Tracking</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f1e8;color:#1f1a14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px}.card{max-width:420px;background:#fffdf8;border:1px solid #e2d8c5;border-radius:20px;padding:24px;text-align:center}p{line-height:1.6;color:#6d6456}</style></head><body><div class="card"><h1>Trip link unavailable</h1><p>${safe}</p></div></body></html>`;
    return response(status, body, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }
}
