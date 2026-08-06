# Student Fingerprint Attendance System

A web-based attendance system for schools. A biometric fingerprint terminal at
the gate pushes scans to a cloud backend; staff see who is present, correct
mistakes, and pull reports from a browser.

Built to the requirements in [`docs/PRD.md`](docs/PRD.md).

---

## What it does

| PRD feature | Where it lives |
|---|---|
| Student & class management | Students and Classes screens; CSV import |
| Fingerprint enrolment | At the terminal; linked to student records automatically, with a queue for anything unmatched |
| Automatic attendance capture | ADMS push endpoints under `/iclock` |
| Live attendance dashboard | Dashboard and the daily register |
| Reports (daily/weekly/monthly/per class/per student) | Reports workspace, exportable as CSV and PDF |
| Manual override | In-place corrections on the register, single or bulk, always with a reason |
| User accounts & roles | Admin, office staff and teacher, with teachers scoped to their own classes; temporary passwords are forced to be changed at first sign-in |
| Absentee alerts | Consecutive-absence detection, surfaced in-app with guardian contacts |

Out of scope for v1, as agreed in the PRD: door access control, a parent-facing
app, staff attendance, and SMS notification.

---

## How it fits together

```
[Fingerprint terminal] --ADMS push over HTTPS--> [Express API] --> [PostgreSQL]
                                                       ^
                                                       | REST
                                              [React dashboard]
```

Three ideas carry most of the design:

**The ledger is separate from the register.** Every scan a terminal ever sends
lands in `attendance_events`, deduplicated and never edited. The daily register,
`attendance_records`, is *derived* from it — one row per student per day,
guaranteed by a database constraint. A staff correction changes the register and
leaves the ledger untouched, so what the device actually saw is always
recoverable. That is the audit trail the PRD asks for.

**Attendance is measured in school days.** Weekends, public holidays and term
breaks come out of the denominator of every rate, and out of the count of
consecutive absences. Without this, a mid-term break reads as a week of truancy.

**Absence is a decision, not a gap.** Until a day is closed, a student with no
scan has *not yet arrived*. A nightly job closes the day and converts those into
explicit absences, which is what makes absence reports and alerts trustworthy.
It is idempotent, and closes the last few days rather than only the current one,
so an outage self-heals.

---

## Repository layout

```
backend/          Node.js + Express API
  src/
    routes/       HTTP layer — validation, auth, response shaping
    services/     Business logic; the attendance engine lives here
    lib/adms/     Terminal wire-protocol codec (no I/O, directly testable)
    db/           Schema migrations, connection pool, seeding
    jobs/         Nightly finalisation and housekeeping
  tests/          181 unit and integration tests, run against real PostgreSQL

frontend/         React (Vite) dashboard
  src/
    pages/        One file per screen
    components/   Shared UI vocabulary and the app shell
    api/          Fetch client with transparent token refresh

scripts/
  simulate-terminal.ps1     Terminal simulator (Windows PowerShell)
  simulate-terminal.sh      Terminal simulator (Linux / macOS)

docs/
  PRD.md                    The original requirements
  API.md                    REST API reference
  DEVICE-INTEGRATION.md     Terminal setup, the ADMS protocol, troubleshooting
  DEPLOYMENT.md             Render + Vercel, and running it locally
```

---

## Quick start

```bash
createdb attendance_dev

cd backend
cp .env.example .env        # set DATABASE_URL and JWT_SECRET
npm install
npm run migrate
npm run seed:demo           # sample school with six weeks of attendance
npm run dev                 # http://localhost:4000

cd ../frontend
npm install
npm run dev                 # http://localhost:5173
```

The demo seed prints its logins. The administrator is `admin@school.local` /
`ChangeMe123!`; office staff and teacher accounts use `Password123`. Sign in as
the teacher to see role scoping in action — they see two classes, not four.

Use `npm run seed` instead for an empty school with just an admin account.

Full instructions, including tests and deployment, are in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

---

## Hardware

The terminal must support **ADMS / push-data over the internet** — see PRD §5 and
[`docs/DEVICE-INTEGRATION.md`](docs/DEVICE-INTEGRATION.md), which covers what to
confirm with the supplier before buying, how to configure the device, and how to
diagnose it when attendance stops arriving.

The protocol is plain-text HTTP, so the whole integration can be exercised in
software before any hardware arrives. `scripts/simulate-terminal.ps1` (Windows)
and `scripts/simulate-terminal.sh` (Linux/macOS) act as a terminal: handshake,
send a punch, and read the register back. Flags cover a late arrival, an unknown
PIN, and a duplicate push.

**Fingerprint templates never leave the device.** The protocol parser reads the
enrolment metadata it needs — which finger, when, on which terminal — and
discards the template payload. The bulk biometric upload endpoints are
acknowledged and stored nowhere.

---

## Tests

```bash
createdb attendance_test
cd backend && npm test
```

181 tests. Unit tests cover the ADMS codec against real captured payloads,
timezone handling across the UTC boundary, temporary-password generation, and
CSV escaping. Integration tests
run against a real PostgreSQL database and cover the attendance engine
(deduplication, late classification, override precedence, day finalisation),
absence-streak arithmetic, report totals, and the HTTP surface including
role-based access.

---

## Open questions for the client

The PRD (§10) leaves several decisions open. Where one was needed to build, the
system was made configurable rather than assuming an answer:

| Question | How it is handled |
|---|---|
| Exact terminal model | Any ADMS-capable device; the serial is registered in the dashboard |
| Number of entry points | Multiple terminals supported with no extra configuration |
| Student population | No fixed limit; the queries are indexed for a single school |
| Internet reliability | The terminal retries until the server confirms storage; days can be closed late and back-filled |
| SMS in v1 or later | Not built. Alerts are in-app, and the alert list carries guardian phone numbers ready for a phase-2 gateway |
| Single school or multi-campus | **Built single-tenant.** Multi-campus would need a school scope on the core tables — worth settling before the schema is carrying live data |

Two further things worth confirming before rollout: the school's exact bell times
and term dates (both entered in the dashboard, but the calendar should be filled
in before the first report is run), and fingerprint reliability with the youngest
year group — the PRD flags this as a risk, and it is best tested with a sample
group rather than discovered at scale.
