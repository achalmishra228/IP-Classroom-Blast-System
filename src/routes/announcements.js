import crypto from 'node:crypto';
import { Router } from 'express';
import { HttpError, assertValid } from '../http-error.js';
import { PRIORITIES, LIMITS, validateAnnouncement } from '../validate.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const toPublic = (a) => ({
  id: a.id,
  teacherId: a.teacherId,
  teacher: a.teacherName,
  subject: a.subject,
  message: a.message,
  priority: a.priority,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});

const asString = (value) => (typeof value === 'string' ? value : '');

function asInt(value, { min, max, fallback }) {
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
}

export function announcementRoutes({ store, auth }) {
  const router = Router();

  router.use(auth.requireAuth);

  // Any logged-in user can read. Newest first.
  // Query: priority=all|normal|important, q=search text, limit (1-100), offset.
  router.get('/', (req, res) => {
    const priority = PRIORITIES.includes(req.query.priority) ? req.query.priority : 'all';
    const q = asString(req.query.q).trim().slice(0, LIMITS.queryMax).toLowerCase();
    const limit = asInt(req.query.limit, { min: 1, max: 100, fallback: 12 });
    const offset = asInt(req.query.offset, { min: 0, max: 1_000_000, fallback: 0 });

    const newestFirst = [...store.data.announcements].reverse();

    const matches = newestFirst.filter((a) => {
      if (priority !== 'all' && a.priority !== priority) return false;
      if (!q) return true;
      return [a.subject, a.message, a.teacherName].some((field) => field.toLowerCase().includes(q));
    });

    // Stats ignore the filter so the home page always shows the whole picture.
    const since = Date.now() - DAY_MS;
    const stats = {
      total: newestFirst.length,
      important: newestFirst.filter((a) => a.priority === 'important').length,
      last24h: newestFirst.filter((a) => Date.parse(a.createdAt) >= since).length,
      latest: newestFirst[0] ? toPublic(newestFirst[0]) : null,
    };

    res.json({
      items: matches.slice(offset, offset + limit).map(toPublic),
      total: matches.length,
      stats,
    });
  });

  // Admin-only from here on.
  router.post('/', auth.requireAdmin, async (req, res) => {
    const { value, errors } = validateAnnouncement(req.body);
    assertValid(errors);

    const now = new Date().toISOString();
    const announcement = {
      id: crypto.randomUUID(),
      teacherId: req.user.id, // taken from the session, never from the request
      teacherName: req.user.name,
      ...value,
      createdAt: now,
      updatedAt: now,
    };

    store.addAnnouncement(announcement);
    await store.save();
    res.status(201).json({ announcement: toPublic(announcement) });
  });

  function findOwned(req) {
    const announcement = store.getAnnouncement(req.params.id);
    if (!announcement) throw new HttpError(404, 'Announcement not found.');
    if (announcement.teacherId !== req.user.id) {
      throw new HttpError(403, 'You can only change your own announcements.');
    }
    return announcement;
  }

  router.patch('/:id', auth.requireAdmin, async (req, res) => {
    const announcement = findOwned(req);
    const { value, errors } = validateAnnouncement(req.body, { partial: true });
    assertValid(errors);

    Object.assign(announcement, value, { updatedAt: new Date().toISOString() });
    await store.save();
    res.json({ announcement: toPublic(announcement) });
  });

  router.delete('/:id', auth.requireAdmin, async (req, res) => {
    const announcement = findOwned(req);
    store.removeAnnouncement(announcement.id);
    await store.save();
    res.status(204).end();
  });

  return router;
}
