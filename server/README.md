# DriveNow Backend

Express + SQLite backend powering the application pipeline, VA/owner portal, and dashboard.

## Local development

```
cp .env.example .env   # edit values as needed
npm install
npm start
```

Server runs on `http://localhost:4000`. Portal: `http://localhost:4000/login.html`

Default owner login (change after first login): the email/password set in `.env` (`OWNER_EMAIL` / `OWNER_PASSWORD`) — both are required before first run, there is no built-in default.

## Deploying

This is a small Node app with a file-based SQLite database — it needs a host that keeps a persistent disk (not pure serverless). Good free/cheap options:

- **Render** (Web Service, free tier, persistent disk add-on for the SQLite file)
- **Railway** (free trial credits, persistent volume)
- **Fly.io** (free allowance, persistent volume)

Steps (Render example):
1. Push this repo to GitHub (already done).
2. New Web Service → connect repo → root directory `server/`.
3. Build command: `npm install`. Start command: `node server.js`.
4. Add a persistent disk mounted at `/server` (or wherever `data.db` and `uploads/` live) so data survives restarts.
5. Set environment variables from `.env.example` in the Render dashboard.
6. Once deployed, copy the live URL (e.g. `https://drivenow-api.onrender.com`).

## Connecting the public marketing site

The public site (`index.html`, `apply.html`, etc.) lives on GitHub Pages and is a separate static deployment. It calls this backend via `API_BASE_URL`, defined in `js/config.js` at the repo root.

Once deployed, update `js/config.js`:

```js
const API_BASE_URL = window.DRIVENOW_API_URL || 'https://your-backend-url.onrender.com';
```

Also set `PUBLIC_SITE_ORIGIN` in the backend's `.env` to your GitHub Pages URL (e.g. `https://your-username.github.io`) so CORS allows the form submissions.

## Pipeline stages

1. Customer Application — public form submission
2. Initial Screening — VA reviews license/age/address/vehicle availability, pass or reject
3. Background Check — VA marks approved / conditional / declined
4. Insurance Quote — admin enters quote amount (manual for now, Day 4 brings real integrations)
5. Quote Presentation — vehicle assigned, weekly rate + total due set
6. Rental Agreement — sent for e-signature, marked signed
7. Invoice & Payment Sent
8. Payment Verification — marks vehicle reserved, pickup scheduled, rental active

SMS/email sending is stubbed into a `messages_outbox` table for now — real Twilio/SendGrid wiring comes Day 3.
