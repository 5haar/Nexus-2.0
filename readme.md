# Nexus TestFlight

![TestFlight logo](https://developer.apple.com/assets/elements/icons/testflight/testflight-64x64_2x.png)

Download the app here:
https://testflight.apple.com/join/QuDHQgDB

After install:
- Sign in with Google using your `@tenex.co` email.
- Apple sign-in is not going to allow Google Drive RAG.

## Google Auth Architecture
The app uses Expo AuthSession to obtain a Google OAuth access token for the signed-in user. The API verifies the token on `POST /api/auth/verify` with `provider: "google"` and returns a Nexus user ID. Drive requests use the Google access token (bearer auth) alongside the Nexus user ID for server-side validation.

## Google Drive Folder RAG Architecture
Drive Chat is a separate scope from screenshot chat. Users must select or paste a Drive folder link, which the API resolves with `POST /api/drive/resolve-link` (folder-only). The client can browse folders via `GET /api/drive/folders/:id`. For chat, the app opens a WebSocket to `/ws` and sends `type: "drive_search"` with the `folderId`, `query`, `model`, and access token. The server fetches up to 50 eligible files (Docs/PDF/plain text), extracts text on demand, embeds, retrieves, and streams the answer with file-name citations.

## Tradeoffs
This repo keeps the app and server in a monolithic structure for rapid prototyping and fast iteration. A production build would typically split UI components, hooks, and services into dedicated modules, and the server would move routes, middleware, and services into separate files for maintainability and testing.
