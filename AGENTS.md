# Nexus-2.0 (iOS + Server) — Agent Guide

This repo is a small monorepo with:

- `nexus/`: Expo (React Native) iOS app (single-screen-style app in one large `App.tsx`)
- `server/`: Node/Express API + WebSocket (RAG + uploads), deployed to AWS Elastic Beanstalk/ALB

Use this file as the source of truth for how to work safely and consistently in this codebase.

## Quick Start (Local Dev)

**Server**

- `cd server`
- `npm install`
- Create `server/.env` using `server/.env.example` (at minimum `OPENAI_API_KEY=...`)
- `npm run dev` (defaults to `http://localhost:4000`)

**App**

- `cd nexus`
- `npm install`
- Run: `npm run ios` (or `npm run start`)
- Set API base:
  - Dev: use the in-app “API base URL” setting (or `EXPO_PUBLIC_API_BASE_URL`).
  - Prod: `EXPO_PUBLIC_API_BASE_URL=https://nexus.ragobble.com` (and WebSocket becomes `wss://` automatically).

## Repo Invariants (Don’t Break These)

- **Do not commit** `node_modules/`, `.expo/`, local storage, or `.env` files (see `.gitignore`).
- **If you change server TypeScript**, also rebuild and commit `server/dist/server.js`:
  - `cd server && npm run build`
  - Commit both `server/src/server.ts` and `server/dist/server.js` together.
- **Production iOS must not rely on insecure HTTP**. Avoid shipping with `NSAllowsArbitraryLoads` or `http://` URLs.
- **Uploads are photos only**. The app imports screenshot photos and the server rejects video uploads.
- **Category fan-out is capped per document** (default `MAX_CATEGORIES_PER_DOC=2`). Don’t reintroduce “category spam”.

## Coding Style & Structure

**General**

- Prefer small, surgical changes over broad refactors.
- Keep UI text concise and consistent with existing copy.
- Avoid adding new dependencies unless necessary; if you do, prefer Expo-compatible modules (`npx expo install ...`).

**App (`nexus/App.tsx`)**

- This file is intentionally “monolithic”. Keep new components as small pure functions near related code.
- Reuse existing primitives (`COLORS`, `FONT_*`, existing button styles) rather than creating new style systems.
- When adding stateful features, consider:
  - `useRef` for non-render state
  - minimizing `useEffect` loops and permission request churn (especially around MediaLibrary)

**Server (`server/src/server.ts`)**

- Treat all input as untrusted (headers, params, body, WS messages).
- Prefer explicit limits: payload size, upload size, timeouts, max categories, etc.
- Keep platform-specific behavior guarded (e.g. macOS-only tools).

## Validation Checklist (Run Before You Say “Done”)

- App typecheck: `cd nexus && npx tsc -p tsconfig.json --noEmit`
- Server build: `cd server && npm run build`
- Smoke test (optional but recommended):
  - Start server and confirm `GET /api/health`
  - From app: Import screenshots → Index → Chat

## Deployment Notes (AWS Elastic Beanstalk)

- Production API base: `https://nexus.ragobble.com`
- TLS terminates at the ALB; the server can run HTTP internally.
- WebSocket endpoint is `/ws`; use `wss://` in production (derived from `EXPO_PUBLIC_API_BASE_URL`).
- Set ALB idle timeout high enough for chat sessions (server pings periodically but don’t rely solely on pings).

## Security Notes (Current State)

- The current “auth” header `x-nexus-user-id` is a temporary mechanism for local/dev and is not secure for public multi-user deployments.
- When implementing real auth (Apple/Google), prefer:
  - `Authorization: Bearer <access_token>` for HTTP
  - WS auth via first message or short-lived token
  - Keychain storage on device (Expo SecureStore)

## Change/Commit Hygiene

- Make commits scoped and descriptive.
- If asked by the user, commit after each logical change.
