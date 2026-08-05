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

Free-tier Render databases are deleted after 90 days. For a live school, use a
paid instance — the PRD's $15–25/month covers this alongside the web service.

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

### Free tier warning

Render's free web services sleep after inactivity and take ~30 seconds to wake.
A sleeping backend will refuse pushes from the terminal — the device retries, so
data is not lost, but the dashboard goes stale and the nightly job may not run.
Use a paid instance for anything real.

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

## 6. Post-deployment checklist

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
- [ ] Database backups confirmed on
- [ ] A second administrator account exists, so one lost password is not a lockout

---

## 7. Running it locally

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

## 8. Costs

| Item | Estimate |
|---|---|
| Render web service (Starter) | ~$7/month |
| Render PostgreSQL (Basic) | ~$7–19/month depending on storage |
| Vercel | free tier is sufficient |
| **Total** | **~$15–25/month**, matching PRD §9 |

Hardware is a one-off: TSh 250,000–600,000 per terminal (PRD §5).

SMS notification (PRD phase 2) is quoted separately by a local provider such as
Beem Africa; it is not wired into this system.
