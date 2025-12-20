# Nexus-2.0 (iOS + Server) — Agent Guide

This repo is a small monorepo with:

- `nexus/`: Expo (React Native) iOS app (single-screen-style app in one large `App.tsx`)
- `server/`: Node/Express API + WebSocket (RAG + uploads), deployed to AWS Elastic Beanstalk/ALB

Current product features include: Apple Sign In gate, paywall + IAP entitlements, screenshot-only uploads, category or screenshot scoped chat, and model selection.

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
- IAP requires a native build (TestFlight or dev client). It will not work in Expo Go.

## Repo Invariants (Don’t Break These)

- **Do not commit** `node_modules/`, `.expo/`, local storage, or `.env` files (see `.gitignore`).
- **If you change server TypeScript**, also rebuild and commit `server/dist/server.js`:
  - `cd server && npm run build`
  - Commit both `server/src/server.ts` and `server/dist/server.js` together.
- **Production iOS must not rely on insecure HTTP**. Avoid shipping with `NSAllowsArbitraryLoads` or `http://` URLs.
- **Uploads are screenshots only**. No videos or documents.
- **Category fan-out is capped per screenshot** (default `MAX_CATEGORIES_PER_DOC=2`). Don’t reintroduce “category spam”.
- **Chat scope is required**. Chat requires a category or a specific screenshot (no “all screenshots” mode).

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

## Environment Variables

**App (Expo public)**
- `EXPO_PUBLIC_API_BASE_URL` (prod: `https://nexus.ragobble.com`)
- `EXPO_PUBLIC_CHAT_MODEL`, `EXPO_PUBLIC_CHAT_MODELS`
- `EXPO_PUBLIC_ENABLE_PAYWALL`, `EXPO_PUBLIC_ENABLE_AUTH`, `EXPO_PUBLIC_REQUIRE_AUTH`
- `EXPO_PUBLIC_IAP_STARTER_PRODUCT_ID`, `EXPO_PUBLIC_IAP_PRO_PRODUCT_ID`, `EXPO_PUBLIC_IAP_MAX_PRODUCT_ID`
- `EXPO_PUBLIC_AUTH_DEBUG` (debug sign-in UI; set to `0` for production)

**Server**
- `OPENAI_API_KEY`
- `APPLE_AUDIENCE` (Apple Sign In audience/bundle ID)
- `APPLE_IAP_SHARED_SECRET`, `APPLE_IAP_BUNDLE_ID`
- `IAP_PRODUCT_STARTER`, `IAP_PRODUCT_PRO`, `IAP_PRODUCT_MAX`
- DB/S3 envs from `server/.env.example`

## iOS Build & Release (EAS/TestFlight)

- Build config: `nexus/eas.json`
- Bundle ID: `com.ragobble.Nexus` in `nexus/app.json`
- Increment `expo.ios.buildNumber` for every TestFlight submission.
- IAP requires a native build on a physical device (Expo Go does not support StoreKit).

## Server API Notes

- Apple auth verification: `POST /api/auth/verify`
- Paywall enforcement: `PAYWALL_ENFORCED` + entitlements in `entitlements` table
- IAP receipt verification: `POST /api/iap/verify`

## Inter-Agent Context & Handoff

- Source of truth for repo behavior: this `AGENTS.md`.
- Long-lived context and decisions: `codex.md` (update when behavior or workflow changes).
- Include in handoffs: current build number, pending EAS build IDs, and any active feature flags.

## Validation Checklist (Run Before You Say “Done”)

- App typecheck: `cd nexus && npx tsc -p tsconfig.json --noEmit`
- Server build: `cd server && npm run build`
- Smoke test (optional but recommended):
  - Start server and confirm `GET /api/health`
  - From app: Apple sign-in → Import screenshots → Index → Chat with category/screenshot
  - Trigger paywall and confirm upgrade modal shows

## Deployment Notes (AWS Elastic Beanstalk)

- Production API base: `https://nexus.ragobble.com`
- TLS terminates at the ALB; the server can run HTTP internally.
- WebSocket endpoint is `/ws`; use `wss://` in production (derived from `EXPO_PUBLIC_API_BASE_URL`).
- Set ALB idle timeout high enough for chat sessions (server pings periodically but don’t rely solely on pings).

## CI/CD (Auto Deploy Server)

This repo includes a GitHub Actions workflow to deploy `server/` to Elastic Beanstalk on push to `main`:

- Workflow: `.github/workflows/deploy-server.yml`
- Target: EB application `nexus`, environment `Nexus-env-1`, region `us-east-1`
- Auth: AWS OIDC (no static AWS keys)

**Required GitHub secret**

- `AWS_ROLE_ARN`: IAM role ARN that GitHub Actions can assume via OIDC

**AWS one-time setup (outline)**

- Create/ensure the GitHub OIDC provider in IAM: `token.actions.githubusercontent.com`
- Create an IAM role with a trust policy allowing your repo/branch to assume it (restrict to `repo:<owner>/<repo>:ref:refs/heads/main`).
- Attach permissions for:
  - `elasticbeanstalk:CreateApplicationVersion`, `elasticbeanstalk:UpdateEnvironment`, `elasticbeanstalk:DescribeEnvironments`, `elasticbeanstalk:DescribeEvents`, `elasticbeanstalk:DescribeEnvironmentHealth`, `elasticbeanstalk:DescribeEnvironmentResources`
  - `s3:PutObject`, `s3:GetObject`, `s3:ListBucket` on the EB bucket (`elasticbeanstalk-us-east-1-<accountId>`)

## Security Notes (Current State)

- The current “auth” header `x-nexus-user-id` is a temporary mechanism for local/dev and is not secure for public multi-user deployments.
- When implementing real auth (Apple/Google), prefer:
  - `Authorization: Bearer <access_token>` for HTTP
  - WS auth via first message or short-lived token
  - Keychain storage on device (Expo SecureStore)

## Change/Commit Hygiene

- Make commits scoped and descriptive.
- If asked by the user, commit after each logical change.
