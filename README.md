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

Settings come from `.env` in the project root — copy [`.env.example`](./.env.example) if you
do not have one. A real environment variable always wins over the file, so the same code runs
unchanged on Render.

With no `DATABASE_URL` the server runs an embedded Postgres (PGlite) that stores its data in
`.data/`. It is meant for development only: it is not crash-safe, and a hard kill can force it
to reset itself. Set `DATABASE_URL` to use a real Postgres locally.

### Checking everything still works

```bash
npm test
```

This boots a throwaway server and database and runs 36 checks across authentication, account
management, device pairing, the call lifecycle and role-based visibility.

## Deploying to Render

Set up as **two** Render resources: a Postgres database and a Web Service.

### 1. The database

**New → Postgres.** Any plan; the free one expires after a limited period. Once it is live,
copy the **Internal Database URL** from its dashboard — internal keeps the traffic on Render's
private network and is faster than the external one.

### 2. The web service

**New → Web Service**, connected to this repository.

| Setting | Value |
| --- | --- |
| Language | Node |
| Build command | `npm ci && npm run build` |
| Start command | `npm start` |
| Health check path | `/api/health` |

Then add these environment variables:

| Key | Value |
| --- | --- |
| `DATABASE_URL` | the Internal Database URL from step 1 |
| `ADMIN_USERNAME` | `admin`, or whatever you prefer |
| `ADMIN_PASSWORD` | the password you want for the administrator |
| `NODE_ENV` | `production` — this marks the session cookie `Secure` |
| `NODE_VERSION` | `22` |

Deploy, then open the `onrender.com` URL. `/api/health` should report
`{"ok":true,"driver":"postgres"}`. If it says `"driver":"pglite"` the service never saw
`DATABASE_URL`, and everything it stores will vanish on the next deploy.

Sign in at `/admin/login` with the username and password you set.

> **The administrator account is created once**, on the first boot against an empty database.
> Setting `ADMIN_PASSWORD` afterwards has no effect — reset the password from inside the app,
> or drop the database to start over.

TLS is negotiated automatically: the server tries an encrypted connection and falls back once
if the database refuses one, which is what Render's internal URL sometimes does. Set
`DATABASE_SSL=on` or `off` to decide it yourself.

`ALLOWED_ORIGINS` is only needed if you ever serve the browser app from a different domain to
the API. Serving both from the one Render service, as above, does not need it.

The committed [`render.yaml`](./render.yaml) describes the same setup as a Blueprint, if you
would rather Render provision both resources for you. It is ignored when you create the
service by hand.

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
