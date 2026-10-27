# Account backend

Separate JavaScript Express project. Implemented routes are `GET /api/v1/health`, `POST /api/v1/auth/google`, `POST /api/v1/auth/logout`, `GET/PATCH/DELETE /api/v1/me`, `GET /api/v1/counter`, `POST /api/v1/me/import-guest`, `POST /api/v1/counter/sync` and `GET /api/v1/leaderboard?period=day|week|month`. The leaderboard response includes the active user's own rank. Health is liveness, not database readiness. The frontend is now in the sibling `../radha-naam-counter` directory.

Use Node.js 22 or newer. From this directory:

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
npm test
```

On Windows with PowerShell script execution disabled, use `npm.cmd` instead of `npm`.

Fill `MONGODB_URI` with a private Atlas connection string. Run `npm run db:indexes` before using accounts: the unique Google identity index is required to prevent duplicate accounts. The four collections and their indexes are defined in `src/models/index.js`. Account creation, session changes and profile edits already use transactions; use a replica set (Atlas supports transactions). Standalone MongoDB is insufficient.

In the frontend root, copy `.env.example` to `.env.local`; `BACKEND_URL=http://localhost:4000` enables the same-origin `/api/v1/*` rewrite. Restart Next.js after changing it. No Google or database secrets belong in `NEXT_PUBLIC_*` variables.

Deployment target: deploy this backend directory as a separate Vercel Express project, with entry point `src/app.js`. Deploy the sibling frontend directory as its own Next.js project. Select project roots according to the repository layout used for deployment. Set `BACKEND_URL` on the frontend to the backend HTTPS origin. Configure credentials through deployment environment settings. No deployment has been performed yet.

## Google and session configuration

1. Create a Google OAuth **Web application** client in your own Google Cloud project. Configure the consent screen and test users as required by that project's publishing status. No Google Drive scopes or client secret are needed for this ID-token flow.
2. Add the exact frontend origin (for example `http://localhost:3000` in development and your frontend HTTPS deployment origin) under authorized JavaScript origins. The GIS popup callback sends the credential to our JSON API.
3. Set frontend `NEXT_PUBLIC_GOOGLE_CLIENT_ID` and backend `GOOGLE_CLIENT_ID` to the same client ID.
4. Set backend `APP_ORIGIN` to the exact frontend origin, with no trailing slash. HTTP is accepted only for localhost development; production requires HTTPS.
5. Set `SESSION_SECRET` to at least 32 random characters using your secrets manager or a cryptographic random generator. Keep it private; rotating it signs out existing cookies.
6. Restart both servers after configuration. Visit `/profile`; use the counter's account icon or Settings → Account.

The production cookie is host-only `__Host-rnjc_session`, Secure, HttpOnly and SameSite=Lax with a 30-day expiry. Local HTTP development uses `rnjc_session` without Secure. The signed cookie carries an opaque random session ID; MongoDB stores only its SHA-256 hash and checks it on every private request. There are no app credentials in localStorage. Private API responses use `Cache-Control: no-store`.

Google's library verifies token signatures, issuer, audience and expiry. Accounts use Google `sub`; signing in refreshes verified email/photo but preserves edited names and saved totals. Another active device gets a 409 until the user explicitly confirms replacement. Old cookies cannot read/edit the account or log out the replacement session. All session/counter ownership changes commit together.

Mutating endpoints require same-origin JSON requests and reject foreign/missing Origin and cross-site Fetch Metadata. No CORS is enabled; always use the frontend rewrite. Login/logout/name editing share a basic in-memory IP limiter (15 attempts per 15 minutes per warm instance). This is not distributed abuse protection; all instances do not share a quota. The app does not trust arbitrary forwarded IP headers.

## Durable progress and API contract

Browser progress now lives in IndexedDB database `rnjc-progress-v1`. Settings remain in localStorage. The legacy `rnjc:count` is read only on initial migration; its stable import ID is retained separately. After the guest import is committed on the server and acknowledged locally, the obsolete count backup is set to zero. Account records contain only progress and ownership IDs, never email, Google credentials or session cookies.

Each tap uses an IndexedDB read/write transaction, so two tabs cannot overwrite each other's increments. A persisted 60-second lease elects a network coordinator, without requiring Web Locks support. Requests have a 15-second client timeout; a crashed tab's lease expires. Duplicate requests after lease expiry remain safe on the server. If storage fails, the counter warns that new in-memory chants cannot survive closing; account sync never sends an unpersisted snapshot.

`/me` and Google sign-in return `profile.counterEpoch`. This is public progress ownership metadata, not an authentication credential. Both progress POST endpoints require it and derive the user solely from the session cookie. A cookie changed in another tab cannot send the old account's queue to the new account. Invalid/replaced sessions keep their queues under the original owner and switch to a separate guest counter.

The client includes a non-secret browser `deviceId` in Google sign-in. After Google verification, it allows this same browser to resume its epoch after logout or expiry if no other active device has intervened. It never bypasses an active-device conflict or authenticates any request. A replacement/different browser gets a new epoch, and older pending progress stays separate with a warning. Replacing a device can still strand that device's offline chants, as explicitly warned in the architecture.

Guest import request: `{ importId: <UUID v4>, totalChants: <nonnegative safe integer>, counterEpoch: <UUID v4> }`. Import creation, guest claiming and the local guest reset are atomic before sending. The backend durably stores both `importedGuestIds` and `guestImports` receipts in `counter_states`, independently of the seven-day operation TTL. A replay returns the original `importedBaseTotal` and current `savedTotalChants`. This lets the client preserve taps made during a lost import reply. Historical imports never write period scores.

Sync request: `{ operationId: <UUID v4>, sequence: <positive safe integer>, totalChants: <nonnegative safe integer>, counterEpoch: <UUID v4>, reason: "mala_completed" | "startup" | "reconnect" | "background" | "manual" | "logout" }`. The server calculates forward-only deltas from the verified cumulative total, then commits the counter, three IST period increments and operation receipt together. Partial checkpoints add no ranking points. Replays after TTL cleanup still cannot add twice. Reusing an operation ID with different progress returns 409. Background sends are best effort; persisted totals and pending snapshots recover on startup.

The profile shows local lifetime progress and pending status. Logout first attempts a checkpoint and requires explicit confirmation to leave pending progress here. A normal logout does not transfer account progress back into guest storage. API caches remain excluded from the service worker; the offline shell cache is now v3.

## Optional Redis acceleration

Set backend-only `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for your own Upstash database, then restart the backend. Leave both empty to use MongoDB alone. No Redis credentials belong in the frontend. Use a database dedicated to this application. The implementation uses the [Upstash REST API](https://upstash.com/docs/redis/features/restapi) and atomic Lua scripts; it adds no runtime Redis client dependency.

Sorted-set keys use `{rnjc:lb}:v1:<day|week|month>:<IST period key>`, sharing one hash slot with metadata. Members are user IDs; stored scores are negative completed-mala totals. Ascending Redis order therefore matches MongoDB's descending mala count / ascending ObjectId tie rule. API scores remain positive malas. `ZADD LT` sets authoritative absolute totals after MongoDB commits; replayed or late writes cannot lower scores or award points twice. Names/photos are always resolved from MongoDB, never cached in Redis.

Sets expire at period start plus 40/90/400 days. A separate 60-second readiness marker bounds stale results after a failed cache write; live score updates do not extend that deadline. Missing/inconsistent metadata or an evicted set triggers rebuild. Rebuilds use expiring staging sets, complete cardinality checks and a random revision fence. Publishing rotates the revision, preventing concurrent or delayed rebuilds from overwriting newer cached state. Rebuilds cap at 2,000 scored users in 500-user chunks; larger cold periods use indexed MongoDB queries instead. This bounds serverless rebuilding work and is not an application user limit.

Account deletion commits in MongoDB first, removes IDs from still-live known ranking sets, advances the revision and writes a 401-day non-secret deletion marker. The marker blocks delayed writes/seeds; missing public profiles force MongoDB fallback. If Redis is unreachable, database deletion still succeeds. Other cached ranks may briefly be stale until their 60-second marker expires after a missed cache update. Requests time out after 800ms; failures open a 30-second process-local circuit. Quota failures, absent configuration and malformed cache responses all fall back to MongoDB. Neither counting nor login depends on Redis.

Tests execute the production Lua through the test-only Fengari VM with a Redis-command model. They cover order/ties, own rank, expired/incomplete sets, race fences, cache outages, retries, deletion and database fallback. This is not a substitute for testing the configured Upstash service or Atlas concurrency. No Upstash credentials have been configured by this implementation. Monitor actual Redis command/storage usage, including scripts/rebuilds, before claiming the free tier fits your traffic.

## Permanent account deletion

`DELETE /api/v1/me` accepts `{ "confirmation": "DELETE", "accountId": "<current user ID>" }`. It requires an active signed session, matching account ID, same-origin JSON and the account rate limit. A MongoDB transaction removes the user, every counter state, every period total and every sync operation. Only after commit is the session cookie cleared. Retrying with the original signed cookie succeeds if the account is already absent; a revoked session cannot delete an existing account. Creating an account again through Google produces a new user ID with zero progress. Redis cleanup runs after commit as described above.

The browser requires typing DELETE and warns that pending chants are discarded. Before the network request it durably erases all local epochs for that user and stores a non-secret deletion-intent ID. Stale profile replies cannot rebind that ID, and old queues are never converted into guest chants. If the request fails, the UI shows an error; refreshing or signing in to that same account retries the confirmed deletion. The obsolete localStorage guest count is zeroed on a best-effort basis. Other users' local queues and independent guest progress remain intact. Remote offline browsers cannot be wiped from this device, but their old sessions and epochs cannot upload to a newly created account.

## Verification and remaining gates

Install dependencies in both frontend and backend, then run frontend `npm test`, `npm run typecheck`, `npm run lint`, and backend `npm test`. Client tests use fake-indexeddb against production storage code, including independent tab connections, lost replies, restart, concurrent taps and composed client/server recovery. Backend tests cover session/input/origin rules, import TTL durability, partial checkpoints, out-of-order totals, rollback, device replacement, rankings, Redis and deletion. Google identity, MongoDB and Redis commands use test adapters; real Google sign-in, Atlas concurrency, hosted Upstash, installed PWA/mobile visual checks and deployment remain release gates.

Reference implementations follow [Google ID-token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token), the [GIS JavaScript API](https://developers.google.com/identity/gsi/web/reference/js-reference), and [MongoDB transactions](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/).
