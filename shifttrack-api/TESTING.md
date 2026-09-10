# Local sandbox

A throwaway environment for testing changes before they reach clients.
Production Supabase is **not addressable** from any command here.

## One-time setup

```bash
cd shifttrack-api
cp .env.local.example .env.local
cp .env.test.example  .env.test

# generate throwaway VAPID keys and paste them into BOTH files.
# required: utils/webpush.js calls setVapidDetails at module load, so the
# API will not boot without a valid-format key pair.
npx web-push generate-vapid-keys
```

Docker Desktop must be running.

## Daily use

```bash
npm run db:up        # start postgres (docker, port 5433)
npm run db:reset     # wipe + migrate + reseed
npm run dev:local    # API on :3000  -> local db
npm run web          # frontend on :5500 -> finds the API automatically
npm test             # syntax check + integration suite
npm run db:down      # stop postgres
```

Then open <http://localhost:5500/admin.html> or `/index.html`.

Seeded logins (password `localdev123` for all):

| Email | Role |
|---|---|
| `admin@local.test` | admin |
| `ayman@local.test` | employee, overnight base schedule |
| `muzan@local.test` | employee, day base schedule |
| `alex@local.test` | employee, an overtime week + an awarded shift |

## Why this is safe

`scripts/assert-local-db.js` parses `DATABASE_URL` and **exits before issuing
any SQL** unless the host is local. `seed.js` and `reset-db.js` both require it
on their first line. Point `.env.local` at a remote host and every destructive
command refuses.

Env selection uses `node --env-file=`. Values already in `process.env` win,
because dotenv does not overwrite them — so the production `.env` cannot
override the sandbox. `.env.local` / `.env.test` deliberately define **every**
key `.env` defines, so nothing can fall through either. Startup should log
`injecting env (0) from .env`; if that number is not 0, a production value is
leaking in and a key is missing from the local file.

## Ports

| Port | What | Note |
|---|---|---|
| 5433 | sandbox postgres | 5432 left alone for your own Postgres 18 |
| 3000 | local API | what the frontend expects |
| 3101 | API under test | booted and killed by the suite |
| 5500 | frontend | already in the API's CORS allowlist |

## Restarting the API after a backend change

`npm run dev:local` runs plain `node`, not nodemon, so **it does not pick up
backend edits** — you must restart it. On Windows, `pkill -f server.js` from
Git Bash does *not* reliably kill it; the old process keeps port 3000 and you
end up testing stale code against a browser that looks fine. Kill it properly:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*server.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Then confirm the port is actually free before restarting:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
```

Tip: if an API change seems to have no effect, check the error text. A stale
process is the usual culprit.

## Tests

```bash
npm test             # everything
npm run test:syntax  # parse every .js file
npm run test:api     # integration suite only
```

`tests/helpers.js` boots the **real** server as a child process against
`.env.test` and drives it over HTTP, so the boot path — including `migrate()` —
is covered. Each test file gets a freshly dropped, migrated and seeded
database; files run sequentially (`--test-concurrency=1`) since they share
port 3101.

Anything importing `db/index.js` starts `migrate()` as an import side effect.
That is why date helpers live in `scripts/pp-dates.js` (no db import) — a test
requiring `scripts/seed.js` at module scope would race the schema drop.

Fixture dates are pinned to fixed pay periods relative to `PP_ANCHOR`, never to
"today", so assertions do not drift every fortnight.

### Known gap recorded as a todo

`tests/shifts.test.js` has one `{ todo: true }` test. `overlapsBaseSchedule`
compares TIME values directly (`start_time < $end AND end_time > $start`),
which is always false for an **overnight** base entry — `22:00 < 05:00` does not
hold in TIME arithmetic. So a shift laid over an overnight base entry is
accepted. Todo tests report but do not fail the run. Fixing it means teaching
the SQL to handle the midnight wrap.

## Not covered

No staging server. When wanted: a second PM2 process on the Hetzner box
(port 3001, own database) deployed from a `staging` branch. Note that
`.github/workflows/deploy.yml` currently ships to clients on **every** push to
`main` touching `shifttrack-api/**`, with no gate.
