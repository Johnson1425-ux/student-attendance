# REST API reference

Base URL: `https://<your-backend>/api`
Device endpoints live outside `/api` — see [DEVICE-INTEGRATION.md](./DEVICE-INTEGRATION.md).

## Conventions

**Authentication.** All `/api` routes except `/api/auth/login` and
`/api/auth/refresh` require a bearer token:

```
Authorization: Bearer <accessToken>
```

**Errors.** Every failure returns the same shape:

```json
{ "error": { "code": "validation_failed", "message": "Some fields need attention",
             "details": { "admissionNumber": "Required" } } }
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `bad_request` | The request is understood but cannot be carried out |
| 401 | `unauthorized` | Missing, expired or invalid token |
| 403 | `forbidden` | Authenticated, but the role or class scope forbids it |
| 404 | `not_found` | No such record |
| 409 | `conflict` | Would break a uniqueness or integrity rule |
| 422 | `validation_failed` | Body or query failed validation; see `details` |
| 429 | `too_many_requests` | Rate limited |

**Dates** are `YYYY-MM-DD` strings in the school's timezone. **Timestamps** are
ISO-8601 UTC instants; render them in the timezone from `GET /api/settings`.

**Paginated** responses look like:

```json
{ "data": [...], "pagination": { "page": 1, "pageSize": 50, "total": 240, "totalPages": 5 } }
```

**Roles.** `admin` · `office_staff` · `teacher`. Teachers are additionally scoped
to the classes assigned to them: list endpoints silently return only their
classes' data, and single-record endpoints return `403` outside that scope.

---

## Authentication

### `POST /api/auth/login`
Rate limited to 10 failed attempts per 15 minutes.

```json
{ "email": "admin@school.local", "password": "…" }
```
→ `{ "user": {...}, "accessToken": "…", "refreshToken": "…", "refreshTokenExpiresAt": "…" }`

Access tokens last 30 minutes by default. Refresh tokens are single-use: each
refresh returns a new one and revokes the old. Presenting an already-used refresh
token revokes every session for that account, on the assumption it was stolen.

### `POST /api/auth/refresh`
`{ "refreshToken": "…" }` → new `accessToken` + `refreshToken`.

### `POST /api/auth/logout`
`{ "refreshToken": "…" }` → `204`.

### `POST /api/auth/logout-all`
Revokes every session for the signed-in user. → `204`

### `GET /api/auth/me`
The signed-in user's current record.

### `POST /api/auth/change-password`
`{ "currentPassword": "…", "newPassword": "…" }`. Signs out all other sessions.
Passwords must be 8+ characters with at least one letter and one digit.

---

## Dashboard

### `GET /api/dashboard?date=`
Everything the landing screen needs, in one call: today's summary, per-class
breakdown, recent scans, open alerts, a 14-day trend, and device health.
Scoped to the caller's classes for teachers; `devices` is empty for them.

---

## Students

### `GET /api/students`
Query: `page`, `pageSize` (≤200), `search`, `classId`, `status`
(`active`|`inactive`|`graduated`|`transferred`|`all`, default `active`),
`hasBiometrics` (`true`|`false`), `sort` (`name`|`admission`|`newest`|`class`).

Paginated. Each row includes `class_name` and `fingerprints_enrolled`.

### `GET /api/students/:id`
Full record plus `biometrics` (finger metadata) and `enrollment_history`.

### `GET /api/students/:id/attendance?from=&to=`
Day-by-day history. Defaults to the last 30 days.

### `POST /api/students` — *admin, office staff*

```json
{ "admissionNumber": "ADM001", "firstName": "Asha", "lastName": "Mushi",
  "deviceUserPin": "1001", "classId": 3, "guardianName": "…",
  "guardianPhone": "+255…", "dateOfBirth": "2012-04-03", "gender": "female" }
```

`deviceUserPin` must be digits and unique. Assigning a PIN that already has
scans recorded against it claims that history for the student.

### `PATCH /api/students/:id` — *admin, office staff*
Any subset of the create fields, plus `transferDate` to date a class move.
Changing `classId` closes the current enrolment and opens a new one, preserving
history.

### `POST /api/students/:id/archive` — *admin, office staff*
`{ "status": "transferred", "exitedOn": "2026-08-05" }`. Ends the enrolment and
resolves any open alerts. Preferred over deletion.

### `DELETE /api/students/:id` — *admin, office staff*
Only permitted when the student has no attendance records; otherwise `409`.

### `POST /api/students/import` — *admin, office staff*
`{ "students": [ { "admissionNumber": "…", "firstName": "…", "lastName": "…",
"className": "Form 1A" }, … ] }` (≤1000 rows).

Rows are processed individually: `{ "created": [...], "failed": [{ "row": 4,
"reason": "…" }], "total": 120 }`.

### `GET /api/students/class/:id/roster`
Active students in one class.

---

## Classes

| Route | Method | Role |
|---|---|---|
| `/api/classes?includeInactive=&academicYear=` | GET | any |
| `/api/classes/:id` | GET | any (scoped) |
| `/api/classes` | POST | admin |
| `/api/classes/:id` | PATCH | admin |
| `/api/classes/:id` | DELETE | admin |

Body: `{ "name", "gradeLevel", "stream", "academicYear", "room", "isActive",
"teacherIds": [1,2] }`. `teacherIds` replaces the assignment set, which is what
controls those teachers' data scope.

A class with any enrolment history cannot be deleted — deactivate it instead.

### Academic terms

`GET /api/classes/terms/all` · `GET /api/classes/terms/current` ·
`POST /api/classes/terms` *(admin)* · `DELETE /api/classes/terms/:id` *(admin)*

---

## Attendance

### `GET /api/attendance/register?date=&classId=&status=&search=`
The daily register: every student expected that day, with their status. Students
who have not scanned appear as `not_marked`. Defaults to today.

→ `{ "date": "…", "summary": {...}, "rows": [...] }`

### `GET /api/attendance/summary?date=&classId=`
Counts only: `expected`, `present`, `late`, `absent`, `excused`, `not_marked`,
`inSchool`, `attendanceRate`.

### `GET /api/attendance/by-class?date=`
Per-class breakdown for the given day.

### `GET /api/attendance/events?limit=&date=`
Recent scans, newest first — the live arrivals feed.

### `GET /api/attendance/unmatched` — *admin, office staff*
PINs that have scanned but match no student, grouped with scan counts.

### `POST /api/attendance/manual` — *admin, office staff*

```json
{ "studentId": 42, "date": "2026-08-05", "status": "present",
  "reason": "Fingerprint would not read; verified at the office",
  "checkInTime": "07:20" }
```

`reason` is required. A manual record outranks device data: later pushes for the
same day update the observed timestamps but leave the corrected status alone.

### `POST /api/attendance/manual/bulk` — *admin, office staff*
`{ "studentIds": [1,2,3], "date": "…", "status": "excused", "reason": "…" }`
(≤500 students) → `{ "updated": 3, "failed": [] }`

### `DELETE /api/attendance/manual/:studentId/:date` — *admin, office staff*
Removes the correction and falls back to what the terminal recorded. If there
were no scans that day the record is deleted entirely.

### `POST /api/attendance/finalize` — *admin*
`{ "date": "2026-08-05" }` or `{ "from": "…", "to": "…" }`, plus optional
`force`. Marks everyone still unmarked as absent and recomputes alerts. Skips
non-school days and future dates unless forced. Idempotent — the nightly job
calls the same code.

### `GET /api/attendance/student/:id?from=&to=`
One student's records over a range.

---

## Reports

Every report accepts `format=json|csv|pdf`. CSV and PDF come back as
attachments; the filename is in `Content-Disposition`.

| Route | Purpose | Key query params |
|---|---|---|
| `/api/reports/daily` | Daily register | `date`, `classId` |
| `/api/reports/weekly` | Per student, current ISO week | `from` (anchor), `classId`, `sort` |
| `/api/reports/monthly` | Per student, calendar month | `from` (anchor), `classId`, `sort` |
| `/api/reports/range` | Per student, any range | `from`, `to`, `classId`, `sort` |
| `/api/reports/by-class` | Per class roll-up | `from`, `to`, `academicYear` |
| `/api/reports/trend` | Day-by-day totals | `from`, `to`, `classId` |
| `/api/reports/chronic-absentees` | Below a threshold, with guardian contacts | `from`, `to`, `threshold` (default 80) |
| `/api/reports/lateness` | Ranked by lateness | `from`, `to`, `minLateDays` |
| `/api/reports/student/:id` | One student's history | `from`, `to` |
| `/api/reports/meta` | Today, timezone, week/month boundaries | — |

`sort`: `name` · `rate_asc` · `rate_desc` · `absences` · `lateness`.

**Two rules apply to every report.** Rates are calculated against *school days*
— weekends and calendar holidays are excluded from the denominator. And a range
extending past today is clamped to today, so a month-to-date report is not
measured against days that have not happened; the response reports `effectiveTo`
alongside the requested `to`.

---

## Absentee alerts

### `GET /api/alerts?status=&classId=&page=&pageSize=`
`status`: `open` (default) · `acknowledged` · `resolved` · `all`. Rows carry the
student, class, streak length, and guardian contact.

### `GET /api/alerts/count`
`{ "open": 3 }` — for the navigation badge.

### `PATCH /api/alerts/:id` — *admin, office staff*
`{ "status": "acknowledged", "notes": "Called the guardian…" }`

### `POST /api/alerts/refresh` — *admin, office staff*
`{ "throughDate": "2026-08-05" }`. Recomputes every student's streak. Use after
changing the threshold or making bulk corrections.

---

## Devices

| Route | Method | Role |
|---|---|---|
| `/api/devices` | GET | admin, office staff |
| `/api/devices/:id` | GET | admin, office staff |
| `/api/devices` | POST | admin |
| `/api/devices/:id` | PATCH | admin |
| `/api/devices/:id/rotate-secret` | POST | admin |
| `/api/devices/:id` | DELETE | admin |
| `/api/devices/:id/commands` | POST | admin, office staff (per command) |
| `/api/devices/commands/catalog` | GET | admin, office staff |
| `/api/devices/users?deviceId=&unlinkedOnly=` | GET | admin, office staff |
| `/api/devices/users/:id/link` | POST | admin, office staff |
| `/api/devices/users/:id/unlink` | POST | admin, office staff |

`POST /api/devices` returns `pushSecret` **once** — it cannot be read back. Each
device carries a `health` field (`online` · `delayed` · `offline` ·
`never_connected`) derived from when it last called in.

`POST /api/devices/users/:id/link` with `{ "studentId": 42 }` assigns the PIN to
the student and backfills any scans already recorded under it, returning the
dates it recovered.

Commands are chosen from a fixed catalog (`info`, `sync_user`, `delete_user`,
`delete_finger`, `query_users`, `query_attlog`, `set_time`, `clear_log`,
`reboot`) — arbitrary strings are rejected.

---

## School calendar

| Route | Method | Role |
|---|---|---|
| `/api/calendar?from=&to=` | GET | any |
| `/api/calendar/resolved?from=&to=` | GET | any |
| `/api/calendar/school-days?from=&to=` | GET | any |
| `/api/calendar` | POST | admin |
| `/api/calendar/:date` | DELETE | admin |

`POST` accepts `{ "date", "endDate", "dayType", "label" }` where `dayType` is
`school_day` · `holiday` · `break` · `weekend`. Supplying `endDate` sets the
whole inclusive range in one call.

`/resolved` explains each date: whether it counts as a school day and whether
that came from an explicit calendar entry or the weekly pattern.

---

## Settings

### `GET /api/settings`
Readable by any signed-in user — the frontend needs the timezone and school name.

### `PATCH /api/settings` — *admin*

| Key | Type | Effect |
|---|---|---|
| `school_name` | string | Dashboard and report headers |
| `timezone` | IANA string | Which day a scan belongs to |
| `school_start_time` | `HH:mm` | Lateness is measured from here |
| `late_after_time` | `HH:mm` | Arrivals after this are late |
| `school_days_of_week` | `[1..7]` | ISO weekdays; 1 = Monday |
| `consecutive_absence_threshold` | int | School days absent before an alert |
| `minimum_checkout_gap_minutes` | int | Before a later scan counts as leaving |
| `auto_finalize_enabled` | bool | Whether the nightly job closes days |
| `report_footer_note` | string | PDF footer |

A cross-field rule is enforced: the late cut-off cannot precede the start of the
school day.

---

## Staff accounts — *admin only*

| Route | Method |
|---|---|
| `/api/users?role=&includeInactive=` | GET |
| `/api/users/:id` | GET |
| `/api/users` | POST |
| `/api/users/:id` | PATCH |
| `/api/users/:id/reset-password` | POST |
| `/api/users/:id` | DELETE |

Creating a user without a `password` generates one and returns it as
`generatedPassword` — shown once, with `must_change_password` set. Deactivating
an account immediately revokes its sessions.

Two guards: you cannot change your own role or deactivate your own account, and
the last active administrator cannot be demoted, deactivated or deleted.

---

## Activity log — *admin only*

### `GET /api/audit?action=&entityType=&entityId=&actorId=&from=&to=&page=`
Paginated, newest first, with `before_data` / `after_data` snapshots.

### `GET /api/audit/actions`
Distinct action names, for building a filter.

---

## Health

### `GET /health`
`{ "status": "ok", "database": "connected", "uptime": 3600 }`, or `503` when the
database is unreachable. Unauthenticated — point Render's health check here.
