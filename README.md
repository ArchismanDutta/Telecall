# Telecall

Telecall is a small browser-based call operations workspace for one administrator and multiple agents.

## Run locally

```bash
npm install
npm run server
```

In a second terminal, start the PWA:

```bash
npm run dev
```

Open the local Vite URL in a browser. The default route opens the admin overview.

The Android phone must reach the API server over the local network. In the Android Bridge app, enter the computer's LAN address, for example `http://192.168.1.20:8787`, rather than `localhost`. Use HTTPS when the app is deployed.

## Render deployment

The included [`render.yaml`](/Users/archismandutta/Desktop/Telecall/render.yaml) is configured as one Node web service. It builds the PWA, serves the PWA and API from the same HTTPS URL, and exposes `/api/health` for health checks.

1. Push this repository to a GitHub repository.
2. In Render, choose **New → Blueprint** and select the repository, or choose **New → Web Service** and use the build command `npm install && npm run build` and start command `npm start`.
3. Wait for the service to deploy, then open its `onrender.com` URL. The PWA and `/api/health` should both load from that URL.
4. Enter that HTTPS URL in the Android Bridge app before pairing a phone.

The current JSON file storage is suitable for an initial hosted test only. Use a persistent database before production; a free Render service can sleep and its local filesystem is not durable across redeploys.

## Routes

- `/admin/login` — admin sign in
- `/admin/dashboard` — admin overview
- `/admin/telecallers` — manage agent accounts
- `/admin/telecallers/new` — create an agent account
- `/admin/telecallers/:id/performance` — performance charts and KPIs
- `/login` — agent sign in
- `/caller` — calling screen
- `/caller/history` — personal call history

## Physical SIM calling

The PWA does not access the SIM directly. The Android Bridge companion in [`android/`](/Users/archismandutta/Desktop/Telecall/android) receives call requests, places calls through the phone's SIM, and reports call state back to the API.

1. Start `npm run server` and `npm run dev`.
2. Create an agent account in the PWA.
3. On the Agents page, choose `Pair device` and keep the six-digit code visible.
4. Open the Android project in Android Studio, install it on the company phone, and grant phone permissions.
5. Enter the PWA/API server URL and the code in Telecall Bridge, then tap `Pair this phone`.
6. After the device is online, the agent can place calls from the PWA through the physical SIM.

An installable debug APK is available at [`android/app/build/outputs/apk/debug/TelecallBridge-debug.apk`](/Users/archismandutta/Desktop/Telecall/android/app/build/outputs/apk/debug/TelecallBridge-debug.apk).

The local UI accepts any non-empty username and password until a backend authentication service is connected. Agent accounts and generated call records are created during use; no accounts or calls are preloaded.

## V1 implementation note

This build includes the PWA, a small local API, and the first Android bridge implementation. Agent accounts and local call records persist in browser `localStorage`; the API persists paired devices and dispatched calls in `.data/telecall.json`. Before production, replace the development auth/storage with a real database and authenticated HTTPS API, and use a push transport instead of polling for stronger background delivery.
# Telecall
