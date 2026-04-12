---
name: Leave management system
description: Design decisions and business rules for the leave/time-off feature
type: project
---

Implemented full leave management system. Key business rules:

**Sick Time:** 40 hrs/year, lump sum on hire date. Unused hrs paid out automatically on anniversary at location hourly rate (logged in sick_time_payouts). Resets to 40 each anniversary. No carryover.

**PTO tiers (by completed years):** <1yr=0, 1yr=8, 2yr=32, 3yr=60, 4-5yr=120, 6-10yr=138, 11+yr=164. Accrues daily (annual/365). Max 40 hrs carry over on anniversary; excess discarded.

**Call Offs:** Employee submits or admin assigns directly. Admin chooses whether to apply sick time (partial OK: uses available sick hrs, rest unpaid). Employee notified when admin assigns.

**Workflow:** pending→approved (hours deducted from balance) or denied (reason required). Employee can cancel pending only. Admin can reverse approved (hours restored).

**DB tables added:** leave_types (seeded: pto/sick_time/call_off), leave_balances, leave_requests, sick_time_payouts.

**Route:** /api/leave — all endpoints in shifttrack-api/routes/leave.js

**Scheduler:** Daily 00:05 cron in scheduler.js handles PTO accrual + anniversary events.

**Employee UI (index.html):** Calendar nav renamed to "Time Off". Sub-tabs: Calendar | Time Off. Time Off shows balance bars + request history + request form. Leave days color-coded in calendar.

**Admin UI (admin.html):** "Leave" tab added. Pending queue with approve/deny. Call-off creation form with sick-time toggle. All-requests table with reverse/convert-sick actions. Pending badge on tab.

**Why:** Company has specific PTO/sick rules. FMLA not implemented yet.
**How to apply:** When modifying leave logic, respect anniversary-based (not calendar-year) calculations. The `leave_balances` table has one row per user per type; available = accrued + carried_over - used.
