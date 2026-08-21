# Deployment

Target architecture from the PRD (§6, §9): backend and PostgreSQL on Render,
dashboard on Vercel, fingerprint terminal pushing to the backend over the
internet.

```
[Fingerprint terminal] --HTTPS--> [Render: Node/Express] --> [Render: PostgreSQL]
                                          ^
                                          | HTTPS (REST)
                                  [Vercel: React dashboard]
```

---

## 1. Database (Render PostgreSQL)

1. **New → PostgreSQL.** Pick the region closest to the school — for Tanzania,
   Frankfurt is usually the lowest-latency option.
2. Note the **Internal Database URL** (for the backend, same-region, no egress
   cost) and the **External Database URL** (for running migrations from your
   laptop).

**Free Render databases expire after 30 days**, with a 14-day grace period to
upgrade before Render deletes them and everything in them. That is fine for a
demonstration and disqualifying for a live school, so for real use take a paid
instance — the PRD's $15–25/month covers it alongside the web service.

**Back it up.** Render's paid tiers include daily backups; verify they are on.
Attendance history is a legal record for many schools, and the whole point of
this system is to stop keeping it on paper.

---

## 2. Backend (Render Web Service)

**New → Web Service**, connected to this repository.

| Setting | Value |
|---|---|
| Root directory | `backend` |
| Runtime | Node |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/health` |

### Environment variables

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | the **Internal** Database URL |
| `DATABASE_SSL` | `true` |
| `JWT_SECRET` | a long random string — see below |
| `CORS_ORIGINS` | your Vercel URL, e.g. `https://attendance.vercel.app` |
| `LOG_LEVEL` | `info` |
| `ENABLE_SCHEDULER` | `true` |
| `FINALIZE_CRON` | `30 23 * * *` (UTC — see §5) |
| `DEVICE_PUSH_SECRET_REQUIRED` | `true` once the terminals are configured |
| `DEVICE_AUTO_REGISTER` | `false` (temporarily `true` during installation) |
| `SEED_ADMIN_EMAIL` | the head teacher's or IT contact's email |
| `SEED_ADMIN_PASSWORD` | a strong temporary password |

Generate the JWT secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Changing it later signs everybody out — which is exactly what you want if it
ever leaks.

`CORS_ORIGINS` accepts a comma-separated list if you have preview deployments.
Do **not** leave it as `*` in production.

### Migrations

Migrations run automatically at start-up, so a deploy brings the schema forward
with no separate step. To run them by hand against the external URL:

```bash
cd backend
DATABASE_URL="<external database url>" DATABASE_SSL=true npm run migrate
```

The runner checksums each migration file and refuses to continue if one was
edited after it was applied, since silent schema drift between environments is
far more expensive than a loud failure. Checksums are taken over LF-normalised
text, so the same committed file matches whether it was checked out on Linux or
on Windows. A database stamped by an older build is recognised and quietly
restamped.

### First-run seed

Once, to create the first administrator:

```bash
DATABASE_URL="<external database url>" DATABASE_SSL=true \
SEED_ADMIN_EMAIL=head@school.example SEED_ADMIN_PASSWORD='…' \
npm run seed
```

It prints the credentials and flags the account to force a password change at
first sign-in. Re-running it is safe — it does nothing if an admin already
exists.

For a demo or training environment, `npm run seed:demo` additionally creates a
sample school with 96 students, four classes, a terminal and six weeks of
attendance. **Never run it against the live database.**

### Free tier walkthrough

The free tier is a good way to get this in front of the school before spending
anything. Know what you are agreeing to first:

| | Free tier behaviour |
|---|---|
| Database | **Expires after 30 days**, then 14 days' grace, then deleted with all data |
| Database size | 1 GB |
| Web service | Sleeps after 15 minutes idle; ~1 minute to wake |
| Instance hours | 750 per workspace per month — enough for one always-on service |
| Shell access | Paid plans only, so seeding is done from your own machine |

A sleeping backend refuses the terminal's push. The device retries and nothing
is lost, but the first scan of the morning may not appear for a minute, and the
nightly finalisation job will not run if the service is asleep at the time. For
a demonstration that is fine. For a live school it is not — and the 30-day
database expiry settles the question anyway.

#### 1. Create the database

**New → Postgres.** Name it, pick the region nearest the school (Frankfurt is
usually the lowest-latency option for East Africa), and choose the **Free**
instance type.

When it is ready, copy both connection strings from the dashboard:

* **Internal Database URL** — for the web service. Same region, no egress cost.
* **External Database URL** — for seeding and backups from your own machine.

#### 2. Create the web service

**New → Web Service**, connect this repository, and **select the branch you want
to deploy** — Render defaults to the repository's default branch, which may not
be the one holding this work.

| Setting | Value |
|---|---|
| Root directory | `backend` |
| Runtime | Node |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/health` |
| Instance type | Free |

Environment variables:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | the **Internal** Database URL |
| `DATABASE_SSL` | `false` — see the note below |
| `JWT_SECRET` | a long random string (command below) |
| `CORS_ORIGINS` | `*` for now; tightened in step 5 |
| `LOG_LEVEL` | `info` |
| `ENABLE_SCHEDULER` | `true` |
| `FINALIZE_CRON` | `30 23 * * *` |

Generate the signing key with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Do **not** set `PORT` — Render injects it, and the app reads it.

On `DATABASE_SSL`: the internal URL is on Render's private network, so `false`
is the right starting point. If the deploy logs show an SSL-related connection
error, set it to `true` and redeploy.

Migrations run automatically at start-up, so there is no separate release step.
A healthy first deploy logs:

```
Database connection established
Database already up to date
Scheduler started
Attendance API listening   port: 10000  env: production
```

#### 3. Seed the demo school from your machine

Render's Shell is a paid feature, so seeding runs locally against the
**External** Database URL. From `backend/`:

```powershell
$env:DATABASE_URL = "<external database url>"
$env:DATABASE_SSL = "true"
npm run seed:demo
```

```bash
DATABASE_URL="<external database url>" DATABASE_SSL=true npm run seed:demo
```

External connections to Render Postgres require SSL, hence `true` here even
though the service itself uses `false` internally.

That creates 96 students, four classes, a terminal and six weeks of attendance,
and prints the logins. Use `npm run seed` instead for an empty school with only
an administrator — which is the right choice the moment real student data is
involved.

#### 4. Deploy the dashboard on Vercel

**Add New → Project**, same repository, then:

| Setting | Value |
|---|---|
| Root directory | `frontend` |
| Framework preset | Vite |
| Build command | `npm run build` |
| Output directory | `dist` |

One environment variable — your Render URL, no trailing slash:

```
VITE_API_BASE_URL = https://your-service.onrender.com
```

Vite inlines this at build time, so changing it later needs a **redeploy**, not
just a restart.

#### 5. Close the loop on CORS

Once Vercel gives you a URL, go back to the Render service and change
`CORS_ORIGINS` from `*` to that exact origin, e.g.
`https://student-attendance.vercel.app`. Render redeploys automatically.

Leaving it as `*` lets any website call your API with a stolen token. It costs
nothing to set properly.

#### 6. Check it works

Visit the Vercel URL and sign in. You will be held at the forced password
change — that is intended. Then confirm:

* the dashboard shows the demo school's figures;
* **Terminals** lists the demo terminal as *never connected* (correct — it does
  not exist);
* a report exports as CSV.

Then point the simulator at the deployed backend to prove the whole scan path
works end to end:

```powershell
.\simulate-terminal.ps1 -BaseUrl 'https://your-service.onrender.com' -Password 'your-password'
```

The first request may take a minute while the free service wakes up.

---

## 3. Frontend (Vercel)

**Add New → Project**, connected to this repository.

| Setting | Value |
|---|---|
| Root directory | `frontend` |
| Framework preset | Vite |
| Build command | `npm run build` |
| Output directory | `dist` |

### Environment variable

| Key | Value |
|---|---|
| `VITE_API_BASE_URL` | `https://attendance-api.onrender.com` (your backend, no trailing slash) |

Vite inlines this at build time, so **changing it requires a redeploy**, not just
a restart.

`vercel.json` already rewrites all routes to `index.html` so client-side routing
works on a hard refresh.

The free tier is genuinely sufficient here (PRD §9): the dashboard is a static
bundle, and all the traffic goes to the backend.

---

## 4. Connecting the terminal

Once the backend is live, follow
[DEVICE-INTEGRATION.md](./DEVICE-INTEGRATION.md). In short:

1. Register the terminal in the dashboard and copy its push secret.
2. On the device, set the ADMS server to your Render hostname, port 443, path
   `/iclock/?key=<secret>`.
3. Confirm it shows as **Online** on the Terminals screen.

---

## 5. The nightly job and timezones

`FINALIZE_CRON` is evaluated in **UTC**, because that is what the server runs in.
Pick a time comfortably after the school day ends, in the school's local time,
then convert:

| School local time | UTC+3 (Dar es Salaam) cron |
|---|---|
| 02:30 | `30 23 * * *` (the previous UTC day) |
| 23:00 | `0 20 * * *` |

The job closes the last few days rather than only the current one, so a night
when the service was asleep or redeploying is picked up on the next run.

It can be disabled entirely from **Settings → Close days automatically** without
a redeploy. With it off, days must be closed by hand from the register — until a
day is closed, "absent" and "has not arrived yet" are the same thing.

---

## 6. Backups

Render's paid PostgreSQL includes daily backups. Everywhere else — a laptop, or
a free-tier managed database — backups are your responsibility, and this is the
single largest risk in those setups. Neon's free plan, for instance, keeps only
**6 hours** of point-in-time recovery, so a Friday problem noticed on Monday is
unrecoverable.

`scripts/` contains a backup and a restore for both shells:

```powershell
# Windows
.\backup-database.ps1 -Folder 'D:\OneDrive\AttendanceBackups' -KeepDays 30
```

```bash
# Linux / macOS
./backup-database.sh -f ~/Dropbox/AttendanceBackups -k 30
```

With no arguments they read `DATABASE_URL` from `backend/.env`, so there is one
place to configure and it cannot drift out of step with the application. Each
run takes a compressed dump, **reads it back to confirm it is not truncated**,
prunes anything past the retention window, and appends to a log beside the
dumps. They exit non-zero on failure, so a scheduler reports a broken backup
instead of silently recording success.

The database is connected to *outbound*, so this works identically whether it
is on Neon, on Render or on the same machine — nothing has to reach in through
your router.

A dump of a full school year is 10–15 MB. Point the folder at something that
syncs to the cloud: a backup living only on the machine it protects is not a
backup, and at this size the second copy is free.

### Scheduling it

On Windows, **Task Scheduler → Create Task**, daily at 21:00, action
`pwsh.exe -File C:\path\to\scripts\backup-database.ps1`. Tick **"Run task as
soon as possible after a scheduled start is missed"** — otherwise a night the
machine is off passes silently.

On Linux, a crontab entry:

```
0 21 * * *  /path/to/scripts/backup-database.sh >> /var/log/attendance-backup.log 2>&1
```

### Rehearse the restore

A backup nobody has restored is a hope, not a plan. Do it once into a scratch
database:

```powershell
.\restore-database.ps1 -ConnectionString 'postgres://user:pw@localhost:5432/attendance_check'
```

It prints the row counts it recovered so you can compare them against what you
expect. The real restore is the same command without the scratch target; it asks
you to type the database name first, because it replaces everything.

### The terminal is a second line of defence

For attendance specifically, the gap between nightly dumps matters less than it
looks. The terminal keeps its own logs — tens of thousands of transactions — so
after a restore you can use **Terminals → Send command → "Re-request attendance
logs"** for the missing range and the device re-pushes them. Deduplication makes
that safe to repeat.

What the terminal cannot give back is everything else: manual corrections, new
student records, staff account changes. That is the real exposure, and it is
small enough to re-enter.

---

## 7. Post-deployment checklist

- [ ] `GET /health` returns `{"status":"ok"}`
- [ ] You can sign in and are forced to change the seeded password
- [ ] **Settings** shows the right school name, timezone and bell times
- [ ] **School calendar** has this term's holidays and breaks entered
- [ ] Classes created and students imported
- [ ] Terminal registered and showing **Online**
- [ ] A test scan appears in the dashboard's arrivals feed within a minute
- [ ] A CSV and a PDF export both download correctly
- [ ] `CORS_ORIGINS` is your Vercel domain, not `*`
- [ ] `DEVICE_AUTO_REGISTER=false`
- [ ] `DEVICE_PUSH_SECRET_REQUIRED=true`
- [ ] Backups running — either Render's, or the scheduled script, and a restore rehearsed
- [ ] A second administrator account exists, so one lost password is not a lockout

---

## 8. Running it locally

```bash
# Database
createdb attendance_dev

# Backend
cd backend
cp .env.example .env          # set DATABASE_URL and JWT_SECRET
npm install
npm run migrate
npm run seed:demo             # or `npm run seed` for an empty school
npm run dev                   # → http://localhost:4000

# Frontend, in a second terminal
cd frontend
npm install
npm run dev                   # → http://localhost:5173, proxying /api to :4000
```

Tests need a separate database:

```bash
createdb attendance_test
cd backend && npm test
```

The suite runs against real PostgreSQL rather than a mock, because a large share
of the logic — the report aggregations, the upsert precedence rules, the
constraint guaranteeing one record per student per day — lives in SQL.

---

## 9. Costs

| Item | Estimate |
|---|---|
| Render web service (Starter) | ~$7/month |
| Render PostgreSQL (Basic) | ~$7–19/month depending on storage |
| Vercel | free tier is sufficient |
| **Total** | **~$15–25/month**, matching PRD §9 |

Hardware is a one-off: TSh 250,000–600,000 per terminal (PRD §5).

SMS notification (PRD phase 2) is quoted separately by a local provider such as
Beem Africa; it is not wired into this system.
