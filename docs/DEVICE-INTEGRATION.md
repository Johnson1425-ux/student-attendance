# Fingerprint terminal integration (ADMS)

How a ZKTeco-style terminal is connected to this system, what happens on the
wire, and how to diagnose it when attendance stops arriving.

---

## 1. Before you buy

The PRD (§5) is right to insist on this, and it is worth repeating because it is
the single most expensive mistake available here:

> **Confirm with the supplier, in writing, that the exact model supports ADMS /
> push-data over the internet.**

"WebAPI supported" on a product listing is **not** the same thing. What this
system needs is the *push* protocol: the terminal makes outbound HTTP requests to
a server URL you configure on the device. Terminals that only offer a pull-style
SDK require software running on a PC on the same LAN as the device, which
defeats the purpose of a cloud backend.

Ask the supplier specifically:

- Does the device menu have **Comm. → Cloud Server Setting** (or **ADMS**)?
- Can it be given a **server address and port** plus a URL path?
- Does it support **domain names** (not just an IP address)? You will be pointing
  it at a Render URL.
- Does it support **HTTPS**? Some older firmware is HTTP-only — see §6.

Known-good families: ZKTeco IN01-A, MB series, uFace, iClock series with
firmware supporting `pushver=2.4.x`.

### Capacity

Match the device to the school roll, with headroom:

| Students | Minimum device capacity |
|---|---|
| up to 500 | 1,000 fingerprints (usually 2 fingers/student = 1,000 templates for 500 pupils) |
| 500–1,500 | 3,000+ fingerprints, and consider a second terminal at the same gate |
| 1,500+ | multiple terminals; queueing at one reader becomes the bottleneck, not storage |

Rule of thumb: enrol **two fingers per student**. A single enrolled finger means a
cut or a plaster turns into a manual correction every morning.

---

## 2. What the terminal actually does

ADMS is a plain-text HTTP protocol. The terminal is the client; this backend is
the server. Everything the device sends and receives is human-readable, which
makes it easy to debug from the logs.

```
Terminal                                    Backend (/iclock/*)
   |                                              |
   |-- GET  /cdata?SN=…&options=all ------------->|  handshake: config + sync stamps
   |<------------------------------ "GET OPTION…" |
   |                                              |
   |-- POST /cdata?SN=…&table=ATTLOG ------------>|  attendance punches
   |<------------------------------- "OK: 14"     |
   |                                              |
   |-- POST /cdata?SN=…&table=OPERLOG ----------->|  new users / fingerprints enrolled
   |<------------------------------- "OK: 2"      |
   |                                              |
   |-- GET  /getrequest?SN=… -------------------->|  "anything for me?"
   |<--------------------- "C:12:DATA UPDATE …"   |
   |-- POST /devicecmd?SN=… (ID=12&Return=0) ---->|  command result
   |<------------------------------- "OK"         |
```

**The critical detail:** the terminal deletes its local copy of a batch only
after the server answers `200` with a body starting `OK`. This backend answers
`OK` **after** the rows are committed to PostgreSQL, and returns an error status
if anything failed. That is what makes an internet outage safe — the device keeps
retrying until the data is genuinely stored (PRD §8).

### Endpoints implemented

| Endpoint | Method | Purpose |
|---|---|---|
| `/iclock/cdata` | GET | Handshake; returns polling intervals and sync stamps |
| `/iclock/cdata?table=ATTLOG` | POST | Attendance punches |
| `/iclock/cdata?table=OPERLOG` | POST | User records and fingerprint enrolment metadata |
| `/iclock/cdata?table=OPTIONS` | POST | Device info and counters |
| `/iclock/getrequest` | GET | Command queue poll |
| `/iclock/devicecmd` | POST | Command acknowledgement |
| `/iclock/ping` | GET | Liveness |
| `/iclock/fdata`, `/rtdata`, `/edata` | POST | Biometric bulk upload — **acknowledged and discarded** |

### Fingerprint templates are never stored

`OPERLOG` lines include a `TMP=` field containing the base64 fingerprint
template. The protocol parser reads the finger index and template *size* and
drops the template itself; the `/fdata` family of endpoints is acknowledged so
the device stops retrying, and nothing is written. Matching happens on the
device (PRD §8).

What the database holds is metadata only: *student X has finger 6 enrolled on
terminal Y since date Z*.

---

## 3. Setting up a terminal

### Step 1 — Register it in the dashboard

**Terminals → Register a terminal.** You need the serial number, which is on a
sticker on the device and in its menu under **System Info → Device Info**.

Registering returns a **push secret**, shown once. Copy it immediately.

Why a secret? ADMS identifies a terminal only by serial number, and a serial
number printed on a case is not a secret. Without one, anyone who learns the
serial could post fabricated attendance. The secret goes in the URL path the
device calls, and the backend rejects any push that does not carry it.

### Step 2 — Configure the device

On the terminal: **Menu → Comm. → Cloud Server Setting** (wording varies by
firmware).

| Setting | Value |
|---|---|
| Server Mode / Protocol | ADMS (or "Domain Name" mode) |
| Server Address | `attendance-api.onrender.com` — your Render hostname, no scheme |
| Server Port | `443` for HTTPS, `80` for HTTP |
| Enable Proxy | No |
| HTTPS / SSL | On, if the firmware supports it |

Some firmware has a separate **URL path** or **Web Address** field. Set it to:

```
/iclock/?key=YOUR_PUSH_SECRET
```

If there is no path field, the device will use `/iclock/` and you must instead
add the source IP to the device's allowlist in the dashboard, or leave the push
secret unset for that device. Setting `DEVICE_PUSH_SECRET_REQUIRED=true` in the
backend environment refuses any device without a secret.

Then set the device clock and timezone: **Menu → System → Date/Time**. The device
sends wall-clock time with no timezone offset, so a wrong device clock produces
attendance recorded at the wrong time. (Its offset is also recorded when you
register it, and the handshake sends the school timezone back.)

### Step 3 — Confirm it is talking

Within a minute or two the dashboard **Terminals** page should show the device as
**Online** with a "last seen" time. If it does not, see §6.

### Step 4 — Enrol students

Enrolment happens **at the terminal**, not in the dashboard — that is where the
fingerprint sensor is.

1. In the dashboard, give the student a **terminal PIN** (Students → Edit). Using
   a number derived from the admission number keeps it memorable.
2. At the terminal: **Menu → User Mgt → New User**, enter that PIN, then enrol
   two fingers.
3. The terminal pushes an `OPERLOG` record. The backend matches the PIN to the
   student automatically, and the student's row in the dashboard shows
   "2 enrolled".

If somebody is enrolled at the terminal with a PIN no student has, the entry
appears under **Terminals → Pending enrolments**, and can be linked to a student
there. Linking claims any scans already recorded under that PIN, so attendance
captured before the link was made is not lost.

---

## 4. Enrolment tips that matter in practice

The PRD flags this under risks (§12), and it is a real one:

- **Younger children** have smaller, softer ridges. Expect a higher failure rate
  under about 8 years old, and test with a sample group before committing to a
  full rollout.
- **Enrol two fingers**, ideally on different hands — index and thumb.
- **Dry or dusty fingers** fail to read. A damp cloth at the terminal solves
  most morning failures.
- **Enrol carefully, once.** A rushed enrolment produces a template that fails
  every morning thereafter. Have the student place the finger three times as
  prompted, flat and centred.
- **Watch the manual-correction rate.** If one student needs a correction most
  days, re-enrol them rather than continuing to patch it by hand.

---

## 5. Remote commands

**Terminals → Send command** queues an instruction the device collects on its
next poll (typically within a minute). Commands come from a fixed catalog — the
API will not forward an arbitrary string to hardware.

| Command | Use |
|---|---|
| Request device status | Refresh user/fingerprint counters |
| Push a student PIN and name | Pre-load a user so the operator only types the PIN |
| Remove a student | When a student leaves the school |
| Remove one fingerprint | Before re-enrolling a finger that reads badly |
| Re-upload the user list | Reconcile after a device was replaced or reset |
| Re-request attendance logs | Recover a date range after an outage |
| Set the terminal clock | After a power loss reset the clock |
| Clear stored logs | Free device memory (destructive; admin only) |
| Reboot | Last resort |

---

## 6. Troubleshooting

### The terminal never appears / stays "Never connected"

Work outwards from the device:

1. **Network.** Can the device reach the internet at all? Most firmware has a
   ping or network test under **Comm. → Network**.
2. **Address.** The server address must have **no scheme and no trailing slash**
   — `attendance-api.onrender.com`, not `https://attendance-api.onrender.com/`.
3. **Port.** `443` with SSL on, or `80` without. A mismatch fails silently.
4. **HTTPS support.** Older firmware cannot do TLS, or cannot do modern TLS.
   Symptom: the device reports a connection error against a URL that works fine
   in a browser. Options, in order of preference:
   - firmware update from the supplier;
   - terminate TLS at a small reverse proxy on the school network that forwards
     to the backend over HTTPS;
   - as a last resort, expose HTTP for the `/iclock` path only, restricted by
     the device's IP allowlist. Attendance data is not highly sensitive, but this
     is still a downgrade — take it knowingly.
5. **Serial mismatch.** Check the dashboard's serial against the device's **exactly**
   — including leading zeros. A mismatch is refused with `403`.

To watch a device connect in real time, tail the backend logs. Every ADMS
request is logged; a refused one says why:

```
"Push from unregistered terminal rejected"     → serial not in the dashboard
"Push rejected: bad device secret"             → wrong or missing ?key=
"Push rejected: source IP not in allowlist"    → IP allowlist too narrow
```

During installation, setting `DEVICE_AUTO_REGISTER=true` makes an unknown serial
create an inactive placeholder device, so the engineer can see the serial in the
dashboard and name it. **Turn it off afterwards.**

### It connects but no attendance arrives

- **Has anyone actually scanned?** Check **Terminals → Unmatched scans**. Scans
  landing there mean the terminal is fine and the PIN mapping is wrong.
- **Transfer flags.** Some firmware has a *Transfer Mode* / *Trans Flag* setting
  that controls which tables it pushes. The handshake sets these, but a device
  that has not re-handshaked since being reconfigured may not have picked them
  up. Reboot it.
- **Stamp stuck.** The device sends only records newer than its sync stamp. If it
  believes it has already sent everything, use **Re-request attendance logs** for
  the date range in question.

### Attendance arrives at the wrong time

Almost always the **device clock**. Check **Menu → System → Date/Time** against a
phone. Use the **Set the terminal clock** command to correct it.

The backend interprets the timestamp using the school timezone from
**Settings → Timezone**, so check that too. A device clock that is right and a
school timezone that is wrong produce the same symptom.

### A student scans but is still marked absent

Check, in order:

1. Is the student **on roll** (`active`) and **enrolled in a class**? Students
   with no class do not appear in the register.
2. Does the student's **terminal PIN** match what was typed at the device?
   **Terminals → Unmatched scans** will show the PIN actually being used.
3. Was the day **already closed** with a manual absence recorded? A manual
   correction outranks device data by design; clear it with **Undo** on the
   register.

---

## 7. Multiple terminals

Several terminals are supported with no extra configuration: register each with
its own serial number and secret. Punches from any of them are attributed to the
same student, and the daily record keeps the earliest arrival of the day
regardless of which gate it came from.

Enrolment, however, is per-device — a fingerprint enrolled on the main gate
terminal is not known to the back gate terminal. Either enrol students on both,
or use the supplier's device-to-device user transfer.

---

## 8. Testing without hardware

The protocol is plain HTTP, so a terminal can be simulated entirely in software.
This is how the integration tests exercise it, and it is the fastest way to
prove the system works before the device arrives.

### The easy way: the simulator script

`scripts/` contains a simulator for both shells. It signs in, registers (or
reuses) a terminal, picks a student, performs the handshake, sends a punch, and
reads the register back to show what the system made of it.

```powershell
# Windows
cd scripts
.\simulate-terminal.ps1 -Password 'your-admin-password'
```

```bash
# Linux / macOS
cd scripts
./simulate-terminal.sh -p 'your-admin-password'
```

Useful variations — each exercises a rule worth confirming:

| Flag (PowerShell / bash) | What it proves |
|---|---|
| *(none)* | A normal arrival is captured and appears on the register |
| `-Late` / `-l` | An arrival after the cut-off is recorded as late, with the minutes |
| `-Pin 9999` / `-n 9999` | An unknown PIN becomes an *unmatched scan* rather than vanishing |
| `-Duplicate` / `-d` | Re-sending the same punch does not create a second record |
| `-Time 07:15` / `-t 07:15` | A specific arrival time, rather than "now" |

The scripts pick a student who has **not** scanned yet where possible. The
register keeps the *earliest* punch of the day as the check-in, so sending a
punch for someone who already arrived correctly changes nothing — which looks
like a failure if you are not expecting it.

### On Windows, `curl` is not curl

In PowerShell, `curl` is an alias for `Invoke-WebRequest`, which takes entirely
different arguments. The bash examples below will fail there with confusing
parameter errors. Use `curl.exe` explicitly, or use the script above.

Multi-line commands with backtick continuations are also easily broken by
copy-and-paste, producing `A positional parameter cannot be found`. Running a
script file avoids the problem altogether.

### By hand, with curl

```bash
BASE=http://localhost:4000
SN=TESTSN0001
KEY=your-push-secret

# 1. Handshake
curl "$BASE/iclock/cdata?SN=$SN&options=all&pushver=2.4.1&key=$KEY"

# 2. Push two punches (tab-separated: PIN, timestamp, status, verify mode)
printf '1001\t2026-08-05 07:12:44\t0\t1\t0\t0\t0\n1002\t2026-08-05 07:51:02\t0\t1\t0\t0\t0\n' \
  | curl --data-binary @- -H 'Content-Type: text/plain' \
    "$BASE/iclock/cdata?SN=$SN&table=ATTLOG&Stamp=100&key=$KEY"
# → OK: 2

# 3. Simulate enrolling a new user at the terminal
printf 'USER PIN=9001\tName=Test Pupil\tPri=0\tPasswd=\tCard=0\tGrp=1\nFP PIN=9001\tFID=6\tSize=1130\tValid=1\tTMP=abc\n' \
  | curl --data-binary @- -H 'Content-Type: text/plain' \
    "$BASE/iclock/cdata?SN=$SN&table=OPERLOG&key=$KEY"

# 4. Collect queued commands
curl "$BASE/iclock/getrequest?SN=$SN&key=$KEY"
```

Sending the same punch twice is safe — the second is recognised as a duplicate
and ignored.

The timestamp you send is interpreted as **school-local wall-clock time**,
exactly as a terminal reports it. That is why a scan sent at 08:30 comes back
as late while one sent at 07:12 does not.
