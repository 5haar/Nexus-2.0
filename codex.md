# Codex Context

Below is the actionable next steps message from Codex prior to the Apple Developer support call:

Here are concrete, Apple-independent next steps you can tackle now, even without a bundle ID, so you're ready to flip the switches once your membership is reinstated.

No Apple Account Required
- Define the paid offering: subscription vs one-time, tiers, and exactly which features are gated (e.g., "Indexing + Chat," "More screenshots," "Faster responses").
- Draft App Store copy assets: app description, keywords, release notes template, support URL, marketing URL, and privacy policy/terms text.
- Decide your auth model and migration plan: how you'll move from the current `x-nexus-user-id` to real accounts without losing existing local data.
- Add feature flags in the app/server (env-controlled) for auth and paywall so you can ship the UI/code paths without enabling them yet.
- Tighten production-ready configuration: remove `NSAllowsArbitraryLoads` before release and ensure HTTPS-only API bases.

Backend/Server Prep
- Add auth scaffolding endpoints (stubbed): token issuance, refresh, and user profile retrieval (even if not wired to Apple yet).
- Add data-model prep for subscriptions: tables/fields for entitlement status, expiry, and last receipt validation.
- Implement receipt validation endpoints and storage logic (you can wire to App Store Server API later).
- Add server-side gating hooks: a single "isEntitled(userId)" check that the API can call before chat/search.

Client UX Prep
- Build a paywall screen and "restore purchases" flow (UI + placeholder logic).
- Build the auth entry points (Sign in button and post-auth linking UI) but hide behind a flag.
- Add a "subscription status" pill or settings section so users can see what they're on (even if it says "not available yet" today).

Testing & Operational Readiness
- Create a test plan checklist: fresh install, import, chat, delete, offline/timeout cases.
- Add minimal telemetry for errors and failed uploads (even console + basic server logs is useful).
- Write a short internal "release runbook" for QA and deploy steps.

If you want, I can start implementing any of the above right now. Pick one or more:
1. Add feature flags + paywall UI (hidden by default).
2. Add auth scaffolding endpoints + user model.
3. Add subscription/entitlement storage + gating hooks.
4. Remove `NSAllowsArbitraryLoads` and tighten API base handling for production.

---

## Current State Snapshot (2025-02-14)

App
- Bundle ID: `com.ragobble.Nexus`
- iOS build number: `4` (from `nexus/app.json`)
- Production env (EAS `production` profile):
  - `EXPO_PUBLIC_API_BASE_URL=https://nexus.ragobble.com`
  - `EXPO_PUBLIC_CHAT_MODEL=gpt-5.2`
  - `EXPO_PUBLIC_CHAT_MODELS=gpt-5.2,gpt-4.1,gpt-4o-mini`
  - `EXPO_PUBLIC_ENABLE_PAYWALL=1`
  - `EXPO_PUBLIC_ENABLE_AUTH=1`
  - `EXPO_PUBLIC_REQUIRE_AUTH=1`
  - `EXPO_PUBLIC_AUTH_DEBUG=0`
  - `EXPO_PUBLIC_IAP_STARTER_PRODUCT_ID=com.ragobble.Nexus.lite_tier`
  - `EXPO_PUBLIC_IAP_PRO_PRODUCT_ID=com.ragobble.Nexus.pro_tier`
  - `EXPO_PUBLIC_IAP_MAX_PRODUCT_ID=com.ragobble.Nexus.max_tier`

Server
- Streaming chat uses WebSocket `/ws` and HTTP SSE `/api/search-stream`.
- Uploads are image-only (screenshots) and stored locally or in S3.
- Paywall enforced via `PAYWALL_ENFORCED` and usage counters (messages/day + total uploads).
- IAP product IDs (server env):
  - `IAP_PRODUCT_STARTER=com.ragobble.Nexus.lite_tier`
  - `IAP_PRODUCT_PRO=com.ragobble.Nexus.pro_tier`
  - `IAP_PRODUCT_MAX=com.ragobble.Nexus.max_tier`

Handoff Notes
- Pending EAS build IDs: none recorded.
- Active feature flags: paywall + auth are enabled in production (see EAS env above).
