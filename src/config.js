import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseTrustProxy(value) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

/**
 * Reads settings from environment variables. `overrides` is used by the tests.
 */
export function loadConfig(overrides = {}) {
  const env = process.env;
  const isProd = env.NODE_ENV === 'production';

  const defaults = {
    root,
    isProd,
    port: Number(env.PORT) || 3000,
    dataFile: path.resolve(root, env.DATA_FILE || 'data/db.json'),
    sessionDays: Number(env.SESSION_DAYS) || 7,
    bcryptRounds: Number(env.BCRYPT_ROUNDS) || 12,
    // The session cookie is only sent over HTTPS when this is true.
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    admin: {
      name: env.ADMIN_NAME,
      email: env.ADMIN_EMAIL,
      password: env.ADMIN_PASSWORD,
    },
    rateLimit: {
      windowMs: 15 * 60 * 1000,
      authMax: 30, // failed auth requests per IP per window
      apiMax: 600, // all API requests per IP per window
      loginMaxFailures: 5, // failed logins per IP + email per window
    },
    quiet: false,
  };

  return {
    ...defaults,
    ...overrides,
    admin: { ...defaults.admin, ...overrides.admin },
    rateLimit: { ...defaults.rateLimit, ...overrides.rateLimit },
  };
}
