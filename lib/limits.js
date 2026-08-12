// Guardrails for running the app somewhere the public can reach it.
//
// None of this is on by default: run it on your own machine and it stays
// unrestricted. Set PUBLIC_MODE=true and the caps below switch on.
//
// Worth being clear about what rate limiting does and does not do. It does not
// defeat YouTube's bot detection — a residential IP and valid cookies are what
// make requests succeed. What it does is keep request volume low enough that
// the IP doesn't get flagged in the first place, and stop one visitor from
// spending all of your home bandwidth.

const env = (name, fallback) => process.env[name] ?? fallback;
const num = (name, fallback) => Number(env(name, fallback));

export const PUBLIC_MODE = env('PUBLIC_MODE', '') === 'true';

export const config = {
  // Per-IP caps, per minute.
  snatchPerMin: num('RATE_LIMIT_SNATCH_PER_MIN', 3),
  pollPerMin: num('RATE_LIMIT_POLL_PER_MIN', 120),
  downloadPerMin: num('RATE_LIMIT_DOWNLOAD_PER_MIN', 10),

  // How many downloads may run at once across everyone. A home box should do
  // one thing at a time — ffmpeg will happily eat every core otherwise.
  maxConcurrentJobs: num('MAX_CONCURRENT_JOBS', 2),

  // Reject long videos before downloading them. 0 disables the cap.
  maxDurationSeconds: num('MAX_DURATION_SECONDS', 1200),
  maxFilesize: env('MAX_FILESIZE', '100M'),

  // Comma-separated origins allowed to call the API from a browser.
  allowedOrigins: String(env('ALLOWED_ORIGINS', ''))
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  // Only read forwarded-IP headers when actually behind a proxy or tunnel.
  trustProxy: env('TRUST_PROXY', '') === 'true',
};

/**
 * The caller's IP. Forwarded headers are trusted only when TRUST_PROXY says a
 * proxy is in front — otherwise anyone could spoof a header and reset their own
 * rate limit by inventing a new IP per request.
 */
export function clientIp(req) {
  if (config.trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return cf.trim();
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Sliding-window rate limiter. A fixed window would let someone fire the whole
 * allowance on either side of a boundary and get double the limit in an instant.
 */
export function rateLimit({ max, windowMs = 60_000, message }) {
  const hits = new Map(); // ip -> timestamps[]

  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, stamps] of hits) {
      const live = stamps.filter((t) => t > cutoff);
      if (live.length) hits.set(ip, live);
      else hits.delete(ip);
    }
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    if (!PUBLIC_MODE) return next();

    const now = Date.now();
    const cutoff = now - windowMs;
    const ip = clientIp(req);
    const stamps = (hits.get(ip) || []).filter((t) => t > cutoff);

    if (stamps.length >= max) {
      const retryAfter = Math.max(1, Math.ceil((stamps[0] + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: message || `Slow down a moment — try again in ${retryAfter}s.`,
        retryAfter,
      });
      return;
    }

    stamps.push(now);
    hits.set(ip, stamps);
    next();
  };
}

/** Tracks how many jobs are in flight so a home machine isn't asked to do ten at once. */
export function createConcurrencyGuard(max = config.maxConcurrentJobs) {
  let active = 0;
  return {
    get active() { return active; },
    get full() { return PUBLIC_MODE && active >= max; },
    enter() { active++; },
    leave() { active = Math.max(0, active - 1); },
  };
}

/**
 * The project's own landing page, which probes /api/health to discover whether
 * a copy is already running on the visitor's machine. Allowed by default so
 * that detection works out of the box, but deliberately scoped to the health
 * endpoint alone — it reveals nothing but "yes, something is listening", and
 * every route that actually does work still requires ALLOWED_ORIGINS.
 */
export const LANDING_ORIGINS = [
  'https://bohanl1u.github.io',
];

/** A page served from this same machine — used while developing the landing page. */
const isLoopbackOrigin = (origin) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

/** CORS for the health check only. See LANDING_ORIGINS for why this is separate. */
export function healthCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (LANDING_ORIGINS.includes(origin)
      || config.allowedOrigins.includes(origin)
      || isLoopbackOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}

/** Permissive CORS, restricted to the origins explicitly allowed. */
export function cors() {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(origin && config.allowedOrigins.includes(origin) ? 204 : 403);
      return;
    }
    next();
  };
}
