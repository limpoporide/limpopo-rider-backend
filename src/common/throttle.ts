// Per-IP limits. Mobile carriers share IPs, so limits are not too tight.
export const DEFAULT_LIMIT = { limit: 300, ttl: 60_000 };

/** For routes that send SMS or create/recover accounts. */
export const STRICT = { default: { limit: 10, ttl: 60_000 } };
