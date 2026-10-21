import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { HttpError, assertValid } from '../http-error.js';
import { validateAccount, validateLogin, LIMITS } from '../validate.js';
import { buildUser, publicUser } from '../users.js';

export function authRoutes({ store, auth, config }) {
  const router = Router();
  const { windowMs, authMax, loginMaxFailures } = config.rateLimit;

  // Compared against when the email is unknown, so "no such user" and "wrong password"
  // take about the same time and cannot be told apart.
  const dummyHash = bcrypt.hashSync('not-a-real-password', config.bcryptRounds);

  // Only failed requests count, so a whole classroom sharing one school IP is not locked out.
  const authLimiter = rateLimit({
    windowMs,
    limit: authMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Too many attempts. Please try again later.' },
  });

  // Failed logins per IP + email, so guessing one account's password gets slow quickly.
  const failures = new Map();
  const failureKey = (req, email) => `${req.ip}|${email}`;

  function secondsLocked(key) {
    const entry = failures.get(key);
    if (!entry) return 0;
    if (entry.resetAt <= Date.now()) {
      failures.delete(key);
      return 0;
    }
    return entry.count >= loginMaxFailures ? Math.ceil((entry.resetAt - Date.now()) / 1000) : 0;
  }

  function recordFailure(key) {
    const now = Date.now();
    if (failures.size > 10_000) {
      for (const [k, entry] of failures) if (entry.resetAt <= now) failures.delete(k);
    }
    const entry = failures.get(key);
    if (!entry || entry.resetAt <= now) failures.set(key, { count: 1, resetAt: now + windowMs });
    else entry.count += 1;
  }

  async function createAccount(body, role) {
    const { value, errors } = validateAccount(body);
    assertValid(errors);

    const taken = () => new HttpError(409, 'An account with this email already exists.', { email: 'This email is already registered.' });
    if (store.getUserByEmail(value.email)) throw taken();

    const user = await buildUser(value, role, config.bcryptRounds);
    // Check again: another request may have registered the same email while we were hashing.
    if (store.getUserByEmail(value.email)) throw taken();

    store.addUser(user);
    return user;
  }

  // Public sign-up always creates a STUDENT. The role is never read from the request.
  router.post('/register', authLimiter, async (req, res) => {
    const user = await createAccount(req.body, 'student');
    await auth.startSession(res, user.id); // also saves the new user
    res.status(201).json({ user: publicUser(user) });
  });

  router.post('/login', authLimiter, async (req, res) => {
    const { value, errors } = validateLogin(req.body);
    assertValid(errors);

    const key = failureKey(req, value.email);
    const wait = secondsLocked(key);
    if (wait > 0) {
      res.set('Retry-After', String(wait));
      throw new HttpError(429, 'Too many failed attempts. Please wait a few minutes and try again.');
    }

    const user = store.getUserByEmail(value.email);
    const tooLong = Buffer.byteLength(value.password) > LIMITS.passwordMaxBytes;
    const passwordOk = !tooLong && (await bcrypt.compare(value.password, user ? user.passwordHash : dummyHash));

    if (!user || !passwordOk) {
      recordFailure(key);
      throw new HttpError(401, 'Incorrect email or password.');
    }

    failures.delete(key);
    store.purgeExpiredSessions();
    await auth.startSession(res, user.id);
    res.json({ user: publicUser(user) });
  });

  // Always succeeds, even when there is no valid session.
  router.post('/logout', async (req, res) => {
    await auth.endSession(req, res);
    res.status(204).end();
  });

  router.get('/me', auth.requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  // Only an existing admin can create another admin account.
  router.post('/admins', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    const user = await createAccount(req.body, 'admin');
    await store.save();
    res.status(201).json({ user: publicUser(user) });
  });

  return router;
}
