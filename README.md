# ShiftTrack

Scheduling for teams that work across more than one location. Staff see their schedule, claim open shifts, request swaps and time off. Managers build the schedule, approve requests, and pull people to another site when one is short-handed.

Installable as a PWA, dark-themed, built phone-first.

**Live:** https://mehdi-khazaal.github.io/shift-track/

## What it does

- **Scheduling** — shifts organised by region and location
- **Open shifts and pulls** — publish uncovered shifts; move staff between sites
- **Swaps** — staff propose a shift swap, a manager approves it
- **Leave and PTO** — requests checked against accrued and available hours
- **Unavailability** — recurring windows when someone can't be scheduled
- **Push notifications** — a scheduler runs every five minutes and reminds people before a shift starts
- **Admin view** — a separate surface for building schedules and clearing approvals

## Stack

| Layer | Stack |
|---|---|
| Frontend | Vanilla JS PWA with a service worker — deployed on **GitHub Pages** |
| API | Node, Express 5, JWT auth with bcrypt, rate limiting, compression |
| Data | Postgres (Supabase in production) with row-level security and SQL migrations |
| Notifications | Web Push (VAPID), driven by a `node-cron` scheduler |

Every table is under Postgres row-level security, so a signed-in user reaches only their own organisation's rows. `npm run verify:rls` asserts it.

## Repository

```
index.html, admin.html, sw.js   the PWA and its service worker
icons/, assets/                 app icons and static assets
shifttrack-api/
  routes/                       auth, shifts, swaps, leave, locations, regions, admin, …
  db/                           schema.sql and migrations
  scheduler.js                  cron job that sends shift reminders
  tests/                        integration tests against a throwaway database
```

## Run it locally

Docker Desktop must be running — Postgres comes up in a container on port 5433.

```bash
cd shifttrack-api
npm install

cp .env.local.example .env.local
cp .env.test.example  .env.test
npx web-push generate-vapid-keys   # paste the pair into both files; the API
                                   # will not boot without valid-format keys

npm run db:up                      # start Postgres
npm run db:reset                   # wipe, migrate, reseed
npm run dev:local                  # API on :3000
npm run web                        # frontend on :5500, finds the API automatically
```

`npm run db:down` stops the database; `npm run db:nuke` also deletes the volume.

## Tests

```bash
npm test              # syntax check plus the integration suite
npm run verify:rls    # asserts row-level security is enforced
```

Tests run against `shifttrack_test`, a separate database wiped on every run, so they never touch the data you were clicking through. See [TESTING.md](shifttrack-api/TESTING.md).
