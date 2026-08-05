# Product Requirements Document
## Student Fingerprint Attendance System

**Version:** 1.0 (Draft for client review)
**Date:** August 2026
**Prepared by:** [Your name]

---

## 1. Overview

A web-based student attendance system that uses a biometric fingerprint terminal to automatically record when students arrive at school, replacing manual roll-call or paper registers. Attendance data is captured at a fingerprint terminal and made available to school staff through a web dashboard for daily tracking, reporting, and absentee follow-up.

## 2. Problem Statement

The school currently tracks attendance manually, which is slow, error-prone, and makes it difficult to generate accurate reports or quickly identify absent students. A biometric system removes proxy attendance (one student marking another present) and gives staff real-time, accurate records.

## 3. Goals

- Automate daily attendance capture using fingerprint verification
- Give teachers/admins a live dashboard of who is present/absent
- Generate attendance reports (daily, weekly, per-class, per-term)
- Reduce manual record-keeping workload for staff
- Provide a reliable audit trail of attendance data

### Out of scope (v1)
- Access control / door locking (this is an attendance log, not a gate security system)
- Parent-facing mobile app (may be a phase 2 feature)
- Payroll or staff attendance (student-only scope for v1)

## 4. Target Users

| Role | Needs |
|---|---|
| School Admin | Full access: manage students, classes, view/export all reports |
| Teacher | View attendance for their own class(es) |
| Office Staff | Enroll new students, handle manual attendance corrections |

## 5. Hardware Requirements

**Device type:** Standalone biometric fingerprint terminal with ADMS (push-data) support — e.g. ZKTeco IN01-A or equivalent model confirmed to support push-over-internet.

**Why this device type:**
- Built-in screen, memory, and fingerprint matching — operates independently, no PC required at the scan point
- Students self-serve (tap and go) — no staff needed to operate it day-to-day
- ADMS support allows the device to push logs directly to a cloud backend over the internet, avoiding the need for an on-site sync agent

**Explicitly not used:**
- USB fingerprint scanners (e.g. ZK9500) — require a PC per scan point, not viable for whole-school daily attendance volume
- Fingerprint access-control readers (e.g. ZKTeco FR1200) — require a separate access control panel (e.g. inBio) and are designed for door/gate access, not attendance logging

**Confirm before purchase:** exact model must be verified with the supplier as supporting ADMS/push-data — not all "WebAPI supported" listings guarantee this.

**Estimated hardware cost:** TSh 250,000–600,000 per unit, depending on model/capacity. One unit is typically sufficient for a single school entrance; additional units needed for multiple gates or very large student populations.

## 6. System Architecture

```
[Fingerprint Terminal] --(ADMS push over internet)--> [Backend API]
                                                              |
                                                         [PostgreSQL DB]
                                                              |
                                                     [React Admin Dashboard]
```

- **Frontend:** React (Vite), deployed on Vercel
- **Backend:** Node.js/Express API, deployed on Render, receives push notifications from the terminal and exposes REST endpoints for the dashboard
- **Database:** PostgreSQL — students, classes, enrollments, attendance records, staff accounts
- **Device integration:** Terminal pushes attendance events to a backend endpoint (ADMS protocol); enrollment (registering fingerprints) is done directly at the terminal

## 7. Core Features (v1)

1. **Student & class management** — add/edit students, assign to classes
2. **Fingerprint enrollment** — via the terminal, linked to student records in the system
3. **Automatic attendance capture** — terminal push events recorded with timestamp
4. **Live attendance dashboard** — today's present/absent list per class
5. **Reports** — daily, weekly, monthly, per-class, per-student attendance history; exportable (CSV/PDF)
6. **Manual override** — staff can manually mark/correct attendance (e.g. injured finger, device downtime)
7. **User accounts & roles** — admin and teacher logins with appropriate access levels
8. **Absentee alerts** — flag students absent for X consecutive days (in-app; SMS is a phase 2 option)

## 8. Non-Functional Requirements

- **Reliability:** system must gracefully handle internet outages at the school — device should retain logs locally and push once connectivity resumes (standard ADMS behavior)
- **Data integrity:** no duplicate attendance records per student per day
- **Performance:** dashboard should load current-day attendance in under 2 seconds for a single school
- **Security:** role-based access; fingerprint templates stored/matched on-device, not as raw images in the cloud database

## 9. Hosting & Recurring Costs

| Item | Estimated Cost |
|---|---|
| Backend hosting (Render) | ~$15–25/month |
| Frontend hosting (Vercel) | Free tier (sufficient at this scale) |
| SMS gateway (optional, phase 2) | Separate quote from local provider (e.g. Beem Africa) |

## 10. Open Questions for Client

- Confirm exact fingerprint terminal model already owned or to be purchased
- Number of entry points / terminals needed
- Approximate student population (affects device capacity requirements)
- Internet reliability at the school site (affects sync/offline handling priority)
- Is SMS/parent notification wanted in v1 or a later phase?
- Single school or multi-campus?

## 11. Milestones (proposed)

| Phase | Deliverable |
|---|---|
| 1 | Device procurement + ADMS confirmation, backend/DB schema, student & class management |
| 2 | Terminal integration (push endpoint), enrollment workflow |
| 3 | Attendance dashboard, reporting, manual override |
| 4 | Testing on-site with real device, staff training, handover |

## 12. Risks

- Device model turns out not to support ADMS as advertised — fallback would require a local sync agent, adding cost/complexity
- Poor school internet connectivity affecting real-time sync (mitigated by device's local storage + retry push)
- Fingerprint matching accuracy issues with younger children (worth testing before full rollout)
