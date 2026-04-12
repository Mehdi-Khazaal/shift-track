---
name: ShiftTrack project overview
description: Stack, architecture, key files, and company context for ShiftTrack
type: project
---

ShiftTrack is a PWA shift-tracking app for Passavant Memorial Homes.

**Stack:** Node/Express API (shifttrack-api/) + single-file HTML frontend (index.html, admin.html). Postgres via Neon. Deployed on Render.

**Key files:**
- `shifttrack-api/server.js` — Express entry, mounts all routes
- `shifttrack-api/db/schema.sql` — Full DB schema (run manually on Neon)
- `shifttrack-api/scheduler.js` — node-cron jobs (push notifications, open shift deadlines, leave accrual)
- `shifttrack-api/routes/` — auth, shifts, schedule, settings, admin, notifications, unavailability, openShifts, swaps, leave
- `index.html` — Employee PWA (single file, all HTML/CSS/JS)
- `admin.html` — Admin panel (single file, all HTML/CSS/JS)

**Why:** Company uses 2-week rotating pay periods anchored to a specific date. OT calculated per calendar week.
