# Social Land

Social Land is a full-stack social app for profiles, friend connections, live direct messaging, peer-to-peer video calls, a shared tic-tac-toe board, and synchronized video playback.

## Run locally

Requirements: Node.js 22+ and a MongoDB database (MongoDB Atlas works).

1. Copy `.env.example` to `.env`.
2. Set `MONGODB_URI` to your database connection string.
3. Replace `JWT_SECRET` with a long random secret.
4. Run `npm install` and then `npm run dev`.
5. Open the Vite URL shown in the terminal. If local HTTPS certificates are installed, use the HTTPS URL in the terminal.

The development command starts the API on port 3001 and Vite on port 5173. Vite proxies API and Socket.IO traffic to the API. `/api/health` reports whether MongoDB connected.

### Gmail password reset

To send real reset emails, enable 2-Step Verification on the sending Google account, create a Google App Password, then set `GMAIL_USER` and `GMAIL_APP_PASSWORD` in `.env`. Use the App Password, not the normal Gmail password, and restart the API. In local development without mail settings, reset links are printed to the API terminal. In production, set `PUBLIC_APP_URL` to the public HTTPS app address and configure the Gmail variables before enabling account recovery.

Profile photos are resized in the browser before being saved to MongoDB. Profiles also support a bio, pronouns, location, and a website link.

For production, build with `npm run build`, set `NODE_ENV=production`, configure `MONGODB_URI`, `JWT_SECRET`, and `CLIENT_ORIGIN`, then run `npm start`. The Express server serves `dist` and the API from the same origin.

## First milestone behavior

- Registration creates a MongoDB ObjectId account ID, unique username, and a password hash. Login accepts the email or username.
- People search is by display name or username. Friend requests must be accepted before a direct chat can be created.
- Direct messages are stored in MongoDB and delivered live through Socket.IO.
- Calls use WebRTC media streams with a public STUN server. Camera and microphone are requested after starting or accepting a call.
- Tic-tac-toe moves and watch-room play, pause, and seek controls are relayed through an authenticated conversation.
- Watch rooms currently accept direct HTTPS media URLs playable by the browser (for example MP4 files). YouTube and subscription services need their authorized player integrations.

## Before public launch

This is a functional first milestone, not a hardened public service. Configure trusted production HTTPS, a TURN service for calls across restrictive networks, email verification, moderation and abuse reporting, message retention controls, automated backups, and production monitoring before inviting the public. Chat content is not end-to-end encrypted in this version.
