# Classroom Blast System

Classroom announcements with login, student and admin (teacher) roles, and a Node.js backend that saves everything on the server.

## Quick start

You need Node.js 20 or newer.

```bash
npm install
cp .env.example .env      # on Windows: copy .env.example .env
```

Open `.env` and set `ADMIN_NAME`, `ADMIN_EMAIL` and `ADMIN_PASSWORD`. This is your first admin (teacher) account. It is created when the server starts.

```bash
npm start                 # or: npm run dev   (restarts on file changes)
```

Open http://localhost:3000.

- **Students** click **Sign up** and create their own account. Sign-up always creates a student.
- **Admins** log in with the account from `.env`. Admins can post, edit and delete their own announcements.
- An admin can create more admin accounts (see the API below). There is no admin sign-up in the browser on purpose.

## What each role can do

| | Student | Admin |
|---|---|---|
| Read announcements, search, filter | Yes | Yes |
| See "Send Blast" page | No | Yes |
| Post an announcement | No | Yes |
| Edit or delete an announcement | No | Only their own |
| Create another admin account | No | Yes (API) |

The server checks the role on every request. Hiding buttons in the page is only for tidiness.

## Where your data is saved

Everything (users, hashed passwords, logins, announcements) is saved in one JSON file on the server: `data/db.json` by default (change with `DATA_FILE`). It is created on the first start and updated after every change. To back up, copy that file. To start fresh, stop the server and delete it.

The file is written safely (temp file, then rename), and the server refuses to start if the file is damaged instead of overwriting it.

This is a good fit for one classroom or one school on a single server process. For many thousands of users or several server processes, move to a real database.

## API

All endpoints are under `/api`. Bodies and responses are JSON.

| Method | Path | Who | What |
|---|---|---|---|
| POST | `/auth/register` | anyone | `{name, email, password}` creates a **student** and logs in |
| POST | `/auth/login` | anyone | `{email, password}` |
| POST | `/auth/logout` | anyone | ends the session |
| GET | `/auth/me` | logged in | current user |
| POST | `/auth/admins` | admin | `{name, email, password}` creates another admin |
| GET | `/announcements` | logged in | `?priority=all\|normal\|important&q=text&limit=12&offset=0`, newest first, plus `total` and `stats` |
| POST | `/announcements` | admin | `{subject, message, priority}` |
| PATCH | `/announcements/:id` | owner admin | any of `subject`, `message`, `priority` |
| DELETE | `/announcements/:id` | owner admin | |

Create a second admin from the command line (log in first so curl keeps the cookie):

```bash
curl -c jar -H "Content-Type: application/json" -d '{"email":"you@example.com","password":"YOUR_PASSWORD"}' http://localhost:3000/api/auth/login
curl -b jar -H "Content-Type: application/json" -d '{"name":"Prof. Rao","email":"rao@example.com","password":"A-strong-password"}' http://localhost:3000/api/auth/admins
```

Errors look like `{"error": "message", "fields": {"email": "message"}}`.

## Security notes

- Passwords are hashed with bcrypt. The hash is never sent to the browser.
- A login is a random token in an `httpOnly`, `SameSite=Lax` cookie. Only a SHA-256 hash of the token is saved on the server. Logging out ends the session on the server.
- The role comes from the server-side account, never from the request. The announcement author also comes from the session.
- Login attempts are throttled: 5 failed attempts per IP and email, then a wait. The same error message is shown for a wrong password and an unknown email.
- All input is validated on the server. The page renders announcements with `textContent`, so HTML in a message cannot run.
- `helmet` sets security headers including a Content Security Policy. Cross-site write requests are rejected.

## Before putting it on the internet

1. Serve it over **HTTPS** (for example behind nginx or Caddy, or on a host that gives you HTTPS).
2. Run with `NODE_ENV=production`. The login cookie is then sent over HTTPS only. If you test production mode over plain `http://localhost`, also set `COOKIE_SECURE=false`.
3. If you run behind a reverse proxy, set `TRUST_PROXY=1` so rate limiting sees real visitor IPs.
4. Use a strong `ADMIN_PASSWORD`, and keep `.env` and `data/` out of version control (already in `.gitignore`).
5. Back up `data/db.json`.

## Tests

```bash
npm test
```

25 automated tests cover sign-up, login, sessions, roles, validation, announcements, saving to disk and restarts.

## Project layout

```
src/
  server.js              starts the server
  app.js                 builds the Express app (security, routes, errors)
  config.js              settings from environment variables
  store.js               in-memory data saved to data/db.json
  auth.js                sessions, requireAuth, requireAdmin
  users.js               password hashing, public user shape
  validate.js            input rules
  routes/auth.js         register, login, logout, me, create admin
  routes/announcements.js  list, create, edit, delete
public/
  index.html
  css/style.css
  js/api.js              all fetch calls to the backend
  js/app.js              screens, roles, rendering
test/api.test.js
```
