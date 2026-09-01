# Telecall

A small browser-based calling workspace: one administrator manages telecaller accounts and
reviews their performance, and each telecaller places calls through the physical SIM in a
paired Android phone.

## What it does

**Administrator** — signs in, creates telecaller accounts, activates or pauses them, resets
passwords, pairs and unpairs Android phones, and reviews any telecaller's performance over a
date range with KPIs, a calls-per-day chart and an outcome breakdown. Every call from every
telecaller is visible, searchable and exportable to CSV.

**Telecaller** — signs in, dials a number, and watches the call progress live while the paired
phone places it over its SIM. Sees their own call history and today's totals, and nobody
else's.

## Running it locally

```bash
npm install
npm run server     # API + database on :8787
npm run dev        # the app, in a second terminal
```

Open the address Vite prints. Sign in at `/admin/login` with the administrator account the
server creates on first boot — it prints the username and a generated password to the console:

```
  Admin account created
    username: admin
    password: xTn3k9QpL
```

That password is shown once. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` before the first run to
choose your own instead.

With no `DATABASE_URL` the server runs an embedded Postgres (PGlite) that stores its data in
`.data/`. It is meant for development only: it is not crash-safe, and a hard kill can force it
to reset itself. Set `DATABASE_URL` to use a real Postgres locally.

### Checking everything still works

```bash
npm test
```

This boots a throwaway server and database and runs 36 checks across authentication, account
management, device pairing, the call lifecycle and role-based visibility.

## Deploying

The included [`render.yaml`](./render.yaml) provisions one Node web service and one managed
Postgres database, and serves the app and the API from the same HTTPS origin.

1. Push this repository to GitHub.
2. In Render, choose **New → Blueprint** and select the repository.
3. Render prompts for `ADMIN_USERNAME` and `ADMIN_PASSWORD`. Set both — otherwise the
   generated password appears only in the deploy log.
4. Open the `onrender.com` URL. `/api/health` reports `{"ok":true,"driver":"postgres"}` when
   the database is wired up correctly.
5. Enter that HTTPS URL in the Android Bridge app before pairing a phone.

A free Render Postgres instance expires after a limited period; a free Neon database works the
same way — set `DATABASE_URL` yourself and drop the `databases:` block.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Falls back to the embedded development database when unset. |
| `ADMIN_USERNAME` | Administrator username, created on first boot. Defaults to `admin`. |
| `ADMIN_PASSWORD` | Administrator password. A random one is generated and logged if unset. |
| `ALLOWED_ORIGINS` | Comma-separated origins allowed to call the API cross-origin. Not needed when the app and API share an origin. |
| `PORT` | Defaults to `8787`. |

## Placing calls through a physical SIM

The browser cannot reach a SIM. The Android companion in [`android/`](./android) receives call
requests, dials them through the phone, and reports state back to the API.

```
browser  →  API  →  Android Bridge  →  SIM  →  customer
```

1. Create a telecaller account, then choose **Pair device** on the Agents page.
2. Open the Android project in Android Studio, install it on the company phone, and grant the
   phone permissions.
3. Enter the server URL and the six-digit code in Telecall Bridge, then tap **Pair this phone**.
   The code is single-use and expires after ten minutes.
4. Once the phone reports in, the telecaller can dial from the calling screen.

An installable debug APK is at
[`android/app/build/outputs/apk/debug/TelecallBridge-debug.apk`](./android/app/build/outputs/apk/debug/TelecallBridge-debug.apk).

## Routes

| Administrator | Telecaller |
| --- | --- |
| `/admin/login` | `/login` |
| `/admin/dashboard` | `/caller` |
| `/admin/telecallers` | `/caller/history` |
| `/admin/telecallers/new` | |
| `/admin/telecallers/:id/performance` | |
| `/admin/call-history` | |

## How it is put together

- `src/main.jsx` — the whole browser app: React, no router library, no chart library.
- `server/index.js` — the HTTP API on `node:http`, no framework.
- `server/db.js` — Postgres via `pg`, or embedded PGlite when there is no `DATABASE_URL`.
- `server/auth.js` — scrypt password hashing and server-side sessions.
- `server/schema.sql` — `users`, `devices`, `calls`, `sessions`, `pairings`, `commands`.
- `android/` — the Android bridge that owns the SIM.

Sessions are opaque tokens stored in the database and sent as an `HttpOnly` cookie; they last
12 hours and are revoked when an account is paused, deleted, or has its password reset. Every
API route requires either a session or a device token.

## Known gaps

- The Android bridge reports a call that was declined as `Missed`; distinguishing **Rejected**
  needs a change on the phone.
- The bridge polls once a second and has no push transport, which is heavy on battery.
- There is no SIM picker on dual-SIM handsets, and no Gradle wrapper in `android/`.
