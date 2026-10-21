import crypto from 'node:crypto';
import { HttpError } from './http-error.js';

export const COOKIE_NAME = 'cb_session';

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Cookie-based sessions. The browser only holds a random token in an httpOnly cookie;
 * the server stores a hash of it, so a leaked database file cannot be used to log in.
 */
export function createAuth({ store, config }) {
  const maxAge = config.sessionDays * 24 * 60 * 60 * 1000;
  const cookieOptions = {
    httpOnly: true, // not readable from JavaScript, which limits what an XSS bug can steal
    sameSite: 'lax', // not sent on cross-site POST, PATCH or DELETE requests
    secure: config.cookieSecure,
    path: '/',
  };

  return {
    async startSession(res, userId) {
      const token = crypto.randomBytes(32).toString('base64url');
      const now = Date.now();
      store.addSession({
        tokenHash: hashToken(token),
        userId,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + maxAge).toISOString(),
      });
      await store.save();
      res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge });
    },

    async endSession(req, res) {
      const token = req.cookies?.[COOKIE_NAME];
      if (token) {
        store.removeSession(hashToken(token));
        await store.save();
      }
      res.clearCookie(COOKIE_NAME, cookieOptions);
    },

    /** Sets req.user when the request carries a valid session cookie. */
    attachUser(req, res, next) {
      const token = req.cookies?.[COOKIE_NAME];
      if (token) {
        const session = store.getSession(hashToken(token));
        if (session && Date.parse(session.expiresAt) > Date.now()) {
          const user = store.getUserById(session.userId);
          if (user) req.user = user;
        }
      }
      next();
    },

    requireAuth(req, res, next) {
      if (!req.user) throw new HttpError(401, 'Please log in to continue.');
      next();
    },

    requireAdmin(req, res, next) {
      if (req.user?.role !== 'admin') throw new HttpError(403, 'Only admins can do that.');
      next();
    },
  };
}
