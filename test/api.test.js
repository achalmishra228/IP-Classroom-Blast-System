import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

const ADMIN = { name: 'Prof. Sharma', email: 'sharma@school.test', password: 'TeacherPass1' };
const STUDENT = { name: 'Asha Patil', email: 'asha@school.test', password: 'StudentPass1' };

const cleanups = [];
after(async () => {
  for (const fn of cleanups) await fn();
});

/** Starts the real app on a random port with its own data file. */
async function startServer({ dataFile, rateLimit } = {}) {
  const dir = dataFile ? path.dirname(dataFile) : await fs.mkdtemp(path.join(os.tmpdir(), 'blast-test-'));
  const file = dataFile ?? path.join(dir, 'db.json');
  const config = loadConfig({
    dataFile: file,
    bcryptRounds: 4, // fast hashing for tests only
    quiet: true,
    admin: ADMIN,
    rateLimit: { authMax: 1000, apiMax: 100_000, ...rateLimit },
  });

  const { app, store } = await createApp(config);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const stop = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await store.flush();
  };
  cleanups.push(async () => {
    await stop().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });

  return { base: `http://127.0.0.1:${server.address().port}`, file, store, stop };
}

/** A tiny HTTP client that remembers cookies, like a browser tab. */
function client(base) {
  let cookie = '';

  async function call(method, url, body, headers = {}) {
    const response = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });

    const setCookies = response.headers.getSetCookie();
    for (const header of setCookies) {
      const [pair] = header.split(';');
      cookie = pair.endsWith('=') ? '' : pair; // an empty value means the cookie was cleared
    }

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON (for example the HTML page)
    }
    return { status: response.status, body: json, text, headers: response.headers, setCookies };
  }

  return {
    get: (url) => call('GET', url),
    post: (url, body, headers) => call('POST', url, body, headers),
    patch: (url, body) => call('PATCH', url, body),
    del: (url) => call('DELETE', url),
    get cookie() {
      return cookie;
    },
    set cookie(value) {
      cookie = value;
    },
  };
}

async function loggedIn(base, credentials) {
  const c = client(base);
  const res = await c.post('/api/auth/login', { email: credentials.email, password: credentials.password });
  assert.equal(res.status, 200, `login as ${credentials.email} failed: ${res.text}`);
  return c;
}

async function signedUpStudent(base, details = STUDENT) {
  const c = client(base);
  const res = await c.post('/api/auth/register', details);
  assert.equal(res.status, 201, res.text);
  return c;
}

describe('authentication', () => {
  test('sign-up creates a student, logs them in, and never exposes the password hash', async () => {
    const { base } = await startServer();
    const c = client(base);

    const res = await c.post('/api/auth/register', STUDENT);
    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.body.user).sort(), ['email', 'id', 'name', 'role']);
    assert.equal(res.body.user.role, 'student');
    assert.equal(res.body.user.email, STUDENT.email);
    assert.ok(!res.text.includes('passwordHash'));

    const me = await c.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.name, STUDENT.name);
    assert.ok(!me.text.includes('passwordHash'));
  });

  test('a role sent in the sign-up request is ignored', async () => {
    const { base } = await startServer();
    const c = client(base);
    const res = await c.post('/api/auth/register', { ...STUDENT, role: 'admin' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'student');
  });

  test('the session cookie is httpOnly and SameSite=Lax', async () => {
    const { base } = await startServer();
    const res = await client(base).post('/api/auth/register', STUDENT);
    const header = res.setCookies.find((h) => h.startsWith('cb_session='));
    assert.ok(header, 'session cookie missing');
    assert.match(header, /HttpOnly/i);
    assert.match(header, /SameSite=Lax/i);
  });

  test('rejects a duplicate email (any letter case) and weak or invalid input', async () => {
    const { base } = await startServer();
    await signedUpStudent(base);
    const c = client(base);

    const dup = await c.post('/api/auth/register', { ...STUDENT, email: STUDENT.email.toUpperCase() });
    assert.equal(dup.status, 409);

    const shortPassword = await c.post('/api/auth/register', { ...STUDENT, email: 'x@school.test', password: 'short' });
    assert.equal(shortPassword.status, 400);
    assert.ok(shortPassword.body.fields.password);

    const badEmail = await c.post('/api/auth/register', { ...STUDENT, email: 'not-an-email' });
    assert.equal(badEmail.status, 400);
    assert.ok(badEmail.body.fields.email);

    const noName = await c.post('/api/auth/register', { ...STUDENT, email: 'y@school.test', name: ' ' });
    assert.equal(noName.status, 400);

    const tooLong = await c.post('/api/auth/register', { ...STUDENT, email: 'z@school.test', password: 'a'.repeat(73) });
    assert.equal(tooLong.status, 400);

    const notStrings = await c.post('/api/auth/register', { name: 1, email: {}, password: [] });
    assert.equal(notStrings.status, 400);
  });

  test('login, me and logout work, and logout ends the session on the server', async () => {
    const { base } = await startServer();
    await signedUpStudent(base);

    const c = await loggedIn(base, STUDENT);
    assert.equal((await c.get('/api/auth/me')).status, 200);

    const sessionCookie = c.cookie;
    assert.equal((await c.post('/api/auth/logout')).status, 204);
    assert.equal((await c.get('/api/auth/me')).status, 401);

    // The old cookie must not work any more, even if someone kept a copy.
    const thief = client(base);
    thief.cookie = sessionCookie;
    assert.equal((await thief.get('/api/auth/me')).status, 401);
  });

  test('wrong password and unknown email give the same generic error', async () => {
    const { base } = await startServer();
    await signedUpStudent(base);
    const c = client(base);

    const wrongPassword = await c.post('/api/auth/login', { email: STUDENT.email, password: 'WrongPass123' });
    const unknownUser = await c.post('/api/auth/login', { email: 'nobody@school.test', password: 'WrongPass123' });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    assert.equal(wrongPassword.body.error, unknownUser.body.error);
  });

  test('repeated failed logins for one account are throttled, even with the right password', async () => {
    const { base } = await startServer();
    await signedUpStudent(base);
    const c = client(base);

    for (let i = 0; i < 5; i += 1) {
      const res = await c.post('/api/auth/login', { email: STUDENT.email, password: 'WrongPass123' });
      assert.equal(res.status, 401);
    }
    const locked = await c.post('/api/auth/login', { email: STUDENT.email, password: STUDENT.password });
    assert.equal(locked.status, 429);
    assert.ok(locked.headers.get('retry-after'));

    // Other accounts are not affected.
    const other = await c.post('/api/auth/login', { email: ADMIN.email, password: ADMIN.password });
    assert.equal(other.status, 200);
  });

  test('passwords are stored as bcrypt hashes and sessions as token hashes, never in plain text', async () => {
    const { base, file, store } = await startServer();
    const c = await signedUpStudent(base);
    await store.flush();

    const raw = await fs.readFile(file, 'utf8');
    assert.ok(!raw.includes(STUDENT.password), 'student password found in data file');
    assert.ok(!raw.includes(ADMIN.password), 'admin password found in data file');
    assert.ok(!raw.includes(c.cookie.split('=')[1]), 'raw session token found in data file');

    const saved = JSON.parse(raw);
    const student = saved.users.find((u) => u.email === STUDENT.email);
    assert.match(student.passwordHash, /^\$2[aby]\$/);
  });

  test('users and logins survive a server restart (data is saved on the backend)', async () => {
    const first = await startServer();
    const c = await signedUpStudent(first.base);
    await first.stop();

    const second = await startServer({ dataFile: first.file });
    // The same browser cookie still works after the restart.
    const sameBrowser = client(second.base);
    sameBrowser.cookie = c.cookie;
    const me = await sameBrowser.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, STUDENT.email);

    const fresh = client(second.base);
    const login = await fresh.post('/api/auth/login', { email: STUDENT.email, password: STUDENT.password });
    assert.equal(login.status, 200);
  });

  test('requests from another origin are rejected', async () => {
    const { base } = await startServer();
    const res = await client(base).post('/api/auth/login', { email: ADMIN.email, password: ADMIN.password }, { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
  });

  test('malformed JSON gets a 400, not a crash', async () => {
    const { base } = await startServer();
    const res = await client(base).post('/api/auth/login', '{"email": ', {});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /JSON/);
  });
});

describe('admin accounts', () => {
  test('the admin from the settings is created on startup and can log in', async () => {
    const { base } = await startServer();
    const res = await client(base).post('/api/auth/login', { email: ADMIN.email, password: ADMIN.password });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'admin');
    assert.equal(res.body.user.name, ADMIN.name);
  });

  test('only an admin can create another admin', async () => {
    const { base } = await startServer();
    const newAdmin = { name: 'Prof. Rao', email: 'rao@school.test', password: 'AnotherPass1' };

    assert.equal((await client(base).post('/api/auth/admins', newAdmin)).status, 401);

    const student = await signedUpStudent(base);
    assert.equal((await student.post('/api/auth/admins', newAdmin)).status, 403);

    const admin = await loggedIn(base, ADMIN);
    const created = await admin.post('/api/auth/admins', newAdmin);
    assert.equal(created.status, 201);
    assert.equal(created.body.user.role, 'admin');

    const login = await client(base).post('/api/auth/login', { email: newAdmin.email, password: newAdmin.password });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.role, 'admin');
  });
});

describe('announcements', () => {
  const post = (admin, overrides = {}) =>
    admin.post('/api/announcements', { subject: 'DSA', message: 'Assignment 3 is due Friday.', priority: 'normal', ...overrides });

  test('every announcement route needs a login', async () => {
    const { base } = await startServer();
    const anon = client(base);
    assert.equal((await anon.get('/api/announcements')).status, 401);
    assert.equal((await anon.post('/api/announcements', { subject: 'x', message: 'y' })).status, 401);
    assert.equal((await anon.del('/api/announcements/abc')).status, 401);
  });

  test('students can read but cannot create, edit or delete', async () => {
    const { base } = await startServer();
    const admin = await loggedIn(base, ADMIN);
    const created = await post(admin);
    const id = created.body.announcement.id;

    const student = await signedUpStudent(base);
    const list = await student.get('/api/announcements');
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);

    assert.equal((await post(student)).status, 403);
    assert.equal((await student.patch(`/api/announcements/${id}`, { subject: 'Hacked' })).status, 403);
    assert.equal((await student.del(`/api/announcements/${id}`)).status, 403);

    const after = await student.get('/api/announcements');
    assert.equal(after.body.items[0].subject, 'DSA');
  });

  test('an admin can create, list, edit and delete', async () => {
    const { base } = await startServer();
    const admin = await loggedIn(base, ADMIN);

    const created = await post(admin, { subject: '  Maths   Quiz ', message: 'Quiz on Monday.\r\nBring a calculator.', priority: 'important' });
    assert.equal(created.status, 201);
    const a = created.body.announcement;
    assert.equal(a.subject, 'Maths Quiz'); // spaces are tidied
    assert.equal(a.message, 'Quiz on Monday.\nBring a calculator.');
    assert.equal(a.priority, 'important');
    assert.equal(a.teacher, ADMIN.name); // taken from the account
    assert.ok(a.id && a.createdAt && a.teacherId);

    const list = await admin.get('/api/announcements');
    assert.equal(list.body.total, 1);
    assert.equal(list.body.stats.important, 1);

    const patched = await admin.patch(`/api/announcements/${a.id}`, { priority: 'normal' });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.announcement.priority, 'normal');
    assert.equal(patched.body.announcement.subject, 'Maths Quiz'); // untouched field stays
    assert.ok(patched.body.announcement.updatedAt >= a.updatedAt);

    assert.equal((await admin.del(`/api/announcements/${a.id}`)).status, 204);
    assert.equal((await admin.get('/api/announcements')).body.total, 0);
    assert.equal((await admin.del(`/api/announcements/${a.id}`)).status, 404);
    assert.equal((await admin.patch(`/api/announcements/${a.id}`, { subject: 'x' })).status, 404);
  });

  test('the author cannot be faked in the request', async () => {
    const { base } = await startServer();
    const admin = await loggedIn(base, ADMIN);
    const res = await post(admin, { teacher: 'Someone Else', teacherId: 'abc', teacherName: 'Someone Else' });
    assert.equal(res.body.announcement.teacher, ADMIN.name);
  });

  test('an admin cannot edit or delete another admin\'s announcement', async () => {
    const { base } = await startServer();
    const admin = await loggedIn(base, ADMIN);
    await admin.post('/api/auth/admins', { name: 'Prof. Rao', email: 'rao@school.test', password: 'AnotherPass1' });
    const rao = await loggedIn(base, { email: 'rao@school.test', password: 'AnotherPass1' });

    const id = (await post(admin)).body.announcement.id;
    assert.equal((await rao.patch(`/api/announcements/${id}`, { subject: 'Mine now' })).status, 403);
    assert.equal((await rao.del(`/api/announcements/${id}`)).status, 403);
    assert.equal((await admin.del(`/api/announcements/${id}`)).status, 204);
  });

  test('validates input', async () => {
    const { base } = await startServer();
    const admin = await loggedIn(base, ADMIN);

    assert.equal((await post(admin, { subject: '' })).status, 400);
    assert.equal((await post(admin, { message: '   ' })).status, 400);
    assert.equal((await post(admin, { subject: 'x'.repeat(81) })).status, 400);
    assert.equal((await post(admin, { message: 'x'.repeat(1001) })).status, 400);
    assert.equal((await post(admin, { priority: 'urgent' })).status, 400);
    assert.equal((await post(admin, { subject: 123 })).status, 400);
    assert.equal((await admin.post('/api/announcements', 'null')).status, 400);

    const id = (await post(admin)).body.announcement.id;
    assert.equal((await admin.patch(`/api/announcements/${id}`, {})).status, 400);
    assert.equal((await admin.patch(`/api/announcements/${id}`, { priority: 'urgent' })).status, 400);
    assert.equal((await admin.patch(`/api/announcements/${id}`, { message: '' })).status, 400);

    // Defaults to "normal" when priority is left out.
    const noPriority = await admin.post('/api/announcements', { subject: 'A', message: 'B' });
    assert.equal(noPriority.body.announcement.priority, 'normal');
  });

  test('lists newest first with filters, search and paging', async () => {
    const { base } = await startServer();
    const admin = await loggedIn(base, ADMIN);

    for (let i = 1; i <= 5; i += 1) {
      await post(admin, { subject: `Note ${i}`, message: i === 4 ? 'Bring your laptop' : `Message ${i}`, priority: i % 2 === 0 ? 'important' : 'normal' });
    }

    const all = (await admin.get('/api/announcements')).body;
    assert.deepEqual(all.items.map((i) => i.subject), ['Note 5', 'Note 4', 'Note 3', 'Note 2', 'Note 1']);
    assert.equal(all.stats.latest.subject, 'Note 5');
    assert.equal(all.stats.total, 5);
    assert.equal(all.stats.last24h, 5);

    const important = (await admin.get('/api/announcements?priority=important')).body;
    assert.deepEqual(important.items.map((i) => i.subject), ['Note 4', 'Note 2']);
    assert.equal(important.stats.total, 5); // stats ignore the filter

    const search = (await admin.get('/api/announcements?q=LAPTOP')).body;
    assert.deepEqual(search.items.map((i) => i.subject), ['Note 4']);
    const byTeacher = (await admin.get('/api/announcements?q=sharma')).body;
    assert.equal(byTeacher.total, 5);

    const page = (await admin.get('/api/announcements?limit=2&offset=2')).body;
    assert.deepEqual(page.items.map((i) => i.subject), ['Note 3', 'Note 2']);
    assert.equal(page.total, 5);

    // Bad numbers fall back to sensible values instead of failing.
    assert.equal((await admin.get('/api/announcements?limit=abc&offset=-5')).status, 200);
    assert.equal((await admin.get('/api/announcements?limit=5000')).body.items.length, 5);
  });

  test('announcements are saved on the backend and survive a restart', async () => {
    const first = await startServer();
    const admin = await loggedIn(first.base, ADMIN);
    await post(admin, { subject: 'Saved', message: 'This must survive a restart.' });
    await first.stop();

    const second = await startServer({ dataFile: first.file });
    const again = await loggedIn(second.base, ADMIN);
    const list = await again.get('/api/announcements');
    assert.equal(list.body.items[0].subject, 'Saved');
  });

  test('HTML in announcements is stored as plain text (the frontend renders it with textContent)', async () => {
    const { base } = await startServer();
    const admin = await loggedIn(base, ADMIN);
    const res = await post(admin, { subject: '<img src=x onerror=alert(1)>', message: '<script>alert(1)</script>' });
    assert.equal(res.status, 201);
    assert.equal(res.body.announcement.message, '<script>alert(1)</script>');
  });
});

describe('server basics', () => {
  test('serves the frontend and sends security headers', async () => {
    const { base } = await startServer();
    const c = client(base);

    const page = await c.get('/');
    assert.equal(page.status, 200);
    assert.match(page.text, /Classroom Blast System/);
    assert.ok(page.headers.get('content-security-policy'));
    assert.equal(page.headers.get('x-powered-by'), null);

    assert.equal((await c.get('/js/app.js')).status, 200);
    assert.equal((await c.get('/css/style.css')).status, 200);
  });

  test('unknown API routes return JSON 404', async () => {
    const { base } = await startServer();
    const res = await client(base).get('/api/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Not found.');
  });

  test('refuses to start on a corrupted data file instead of wiping it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blast-test-'));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'db.json');
    await fs.writeFile(file, '{ this is not json');

    await assert.rejects(startServer({ dataFile: file }), /not valid JSON/);
    assert.equal(await fs.readFile(file, 'utf8'), '{ this is not json'); // left untouched
  });
});
