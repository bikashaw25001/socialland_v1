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

### AI assistant

To enable general answers for all site users, create a key in [GroqCloud](https://console.groq.com/keys), set `GROQ_API_KEY` in the API server `.env`, and restart the API. The key stays on the server and is never sent to browsers. `GROQ_MODEL` defaults to `openai/gpt-oss-20b`; change it to another model currently available to your GroqCloud account if needed. Assistant messages are sent to GroqCloud for generation, so users should not send sensitive information.
### Gmail password reset

To send real reset emails, enable 2-Step Verification on the sending Google account, create a Google App Password, then set `GMAIL_USER` and `GMAIL_APP_PASSWORD` in `.env`. Use the App Password, not the normal Gmail password, and restart the API. In local development without mail settings, reset links are printed to the API terminal. In production, set `PUBLIC_APP_URL` to the public HTTPS app address and configure the Gmail variables before enabling account recovery.

Profile photos are resized in the browser before being saved to MongoDB. Profiles also support a bio, pronouns, location, and a website link.

### Reel video delivery

Reels are transcoded in the background to three H.264 HLS quality levels (up to 360p, 540p, and 720p). The player switches quality based on connection and buffer conditions through HLS.js, with native HLS used where available. The uploaded source remains available as a fallback. When the configured FFmpeg build includes the selected AV1 encoder, the server also creates a more compact AV1 MP4 as an optional compatible-browser rendition; AV1 jobs run one at a time. Install FFmpeg on the API host and set `FFMPEG_PATH` if it is not on `PATH`. Set `REEL_AV1=false` to skip AV1, or set `REEL_AV1_ENCODER` to an encoder such as `libsvtav1` when available. Generated streams are stored in `server/reel-streams` and should use persistent disk in production.

### Post and Reel nudity moderation

Image and video post uploads are held in `server/pending-uploads` and hidden from feeds until the server-side ONNX image classifier approves them. The model is downloaded from Hugging Face on first startup and cached locally under `server/model-cache` (set `CONTENT_MODERATION_CACHE` to change that location); the API host needs outbound internet access for this initial download. Reels and videos are checked using up to 12 frames from their first 60 seconds. Set `CONTENT_MODERATION_THRESHOLD` to adjust the NSFW confidence threshold (default `0.88`). A flagged upload is deleted and generates an in-app warning; the third flagged post or Reel permanently bans the account and revokes its sessions. The classifier can make mistakes, so the confidence threshold is intentionally conservative.

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
"# social-land" 
