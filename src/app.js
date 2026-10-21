import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { Store } from './store.js';
import { createAuth } from './auth.js';
import { HttpError, firstError } from './http-error.js';
import { validateAccount } from './validate.js';
import { buildUser } from './users.js';
import { authRoutes } from './routes/auth.js';
import { announcementRoutes } from './routes/announcements.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Creates the first admin from ADMIN_* settings, or warns if there is no admin at all. */
async function seedAdmin(store, config, log) {
  const { name, email, password } = config.admin;

  if (!email && !password) {
    if (!store.hasAdmin()) {
      log('No admin account exists yet. Set ADMIN_EMAIL and ADMIN_PASSWORD (see .env.example) and restart to create one.');
    }
    return;
  }

  const { value, errors } = validateAccount({ name: name || 'Admin', email, password });
  if (Object.keys(errors).length > 0) {
    throw new Error(`Invalid ADMIN_NAME / ADMIN_EMAIL / ADMIN_PASSWORD: ${firstError(errors)}`);
  }
  if (store.getUserByEmail(value.email)) return; // already created on an earlier start

  store.addUser(await buildUser(value, 'admin', config.bcryptRounds));
  await store.save();
  log(`Created admin account for ${value.email}`);
}

export async function createApp(config) {
  const log = config.quiet ? () => {} : (message) => console.log(message);

  const store = new Store(config.dataFile);
  await store.load();
  await seedAdmin(store, config, log);

  const auth = createAuth({ store, config });
  const app = express();

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          // Safari would try to load http://localhost over https with this directive.
          'upgrade-insecure-requests': config.isProd ? [] : null,
        },
      },
    }),
  );
  app.use(express.json({ limit: '10kb' }));
  app.use(cookieParser());

  // ---- API ----
  const api = express.Router();

  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Extra CSRF protection on top of the SameSite cookie: browsers always send an Origin
  // header on cross-site writes, so reject any whose origin is not this server.
  api.use((req, res, next) => {
    const origin = req.get('origin');
    if (!SAFE_METHODS.has(req.method) && origin) {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(origin).host === req.get('host');
      } catch {
        // invalid Origin header: treated as cross-site
      }
      if (!sameOrigin) throw new HttpError(403, 'Cross-site requests are not allowed.');
    }
    next();
  });

  api.use(
    rateLimit({
      windowMs: config.rateLimit.windowMs,
      limit: config.rateLimit.apiMax,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Too many requests. Please slow down.' },
    }),
  );

  api.use(auth.attachUser);
  api.use('/auth', authRoutes({ store, auth, config }));
  api.use('/announcements', announcementRoutes({ store, auth }));
  api.use((req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  app.use('/api', api);

  // ---- frontend ----
  app.use(express.static(path.join(config.root, 'public')));

  // ---- errors ----
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, ...(err.fields ? { fields: err.fields } : {}) });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body is not valid JSON.' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request is too large.' });
    }

    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  return { app, store, log };
}
