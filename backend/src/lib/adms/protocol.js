/**
 * ADMS ("push SDK") wire-format codec for ZKTeco-style fingerprint terminals.
 *
 * The protocol is deliberately primitive: the terminal makes plain HTTP
 * requests with tab-separated text bodies and expects short text replies. All
 * of the parsing quirks live here so the routes and services can work with
 * ordinary JavaScript objects.
 *
 * Reference exchange:
 *
 *   GET  /iclock/cdata?SN=ABC123&options=all&pushver=2.4.1   → handshake config
 *   POST /iclock/cdata?SN=ABC123&table=ATTLOG                → punch records
 *   POST /iclock/cdata?SN=ABC123&table=OPERLOG               → user/finger ops
 *   GET  /iclock/getrequest?SN=ABC123                        → pending commands
 *   POST /iclock/devicecmd?SN=ABC123                         → command results
 *
 * Nothing in this module touches the database or the clock, which makes it
 * directly unit-testable against captured device payloads.
 */

/** Attendance punch states reported in ATTLOG field 3. */
export const PUNCH_STATES = {
  0: 'check_in',
  1: 'check_out',
  2: 'break_out',
  3: 'break_in',
  4: 'overtime_in',
  5: 'overtime_out',
};

/** Verification methods reported in ATTLOG field 4. */
export const VERIFY_MODES = {
  0: 'password',
  1: 'fingerprint',
  2: 'card',
  3: 'password',
  4: 'card',
  9: 'other',
  15: 'face',
  25: 'palm',
};

function splitLines(body) {
  if (!body) return [];
  return String(body)
    .split(/\r\n|\r|\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

/**
 * Parse `Key=Value` pairs separated by tabs (the terminal's field encoding).
 * Values may legitimately be empty, and keys are normalised to lower case.
 */
function parseKeyValueFields(text) {
  const out = {};
  for (const chunk of String(text).split('\t')) {
    const idx = chunk.indexOf('=');
    if (idx <= 0) continue;
    const key = chunk.slice(0, idx).trim().toLowerCase();
    out[key] = chunk.slice(idx + 1).trim();
  }
  return out;
}

const toIntOrNull = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
};

/**
 * Parse an ATTLOG body.
 *
 * Field layout (tab separated):
 *   0 PIN  1 DateTime  2 Status/PunchState  3 VerifyMode  4 WorkCode  5.. reserved
 *
 * Malformed lines are returned in `errors` rather than aborting the batch: a
 * single corrupt record must never block the rest of a day's attendance.
 */
export function parseAttlog(body) {
  const records = [];
  const errors = [];

  splitLines(body).forEach((line, index) => {
    const fields = line.split('\t');
    const pin = (fields[0] ?? '').trim();
    const timestamp = (fields[1] ?? '').trim();

    if (!pin || !timestamp) {
      errors.push({ line: index + 1, raw: line, reason: 'missing PIN or timestamp' });
      return;
    }
    if (!/^\d+$/.test(pin)) {
      errors.push({ line: index + 1, raw: line, reason: `non-numeric PIN "${pin}"` });
      return;
    }

    records.push({
      pin,
      timestamp,
      punchState: toIntOrNull(fields[2]),
      verifyMode: toIntOrNull(fields[3]),
      workCode: (fields[4] ?? '').trim() || null,
      raw: line,
    });
  });

  return { records, errors };
}

/**
 * Parse an OPERLOG body. It multiplexes several record kinds, distinguished by
 * a leading token:
 *
 *   USER PIN=1\tName=Asha\tPri=0\tCard=…   → user created/updated at terminal
 *   FP   PIN=1\tFID=6\tSize=1130\tValid=1\tTMP=<base64 template>
 *   OPLOG 4\t1\t…                          → device operation log
 *
 * The TMP (template) field is deliberately dropped here — only its size is
 * kept — so raw biometric data never reaches the database (PRD §8).
 */
export function parseOperlog(body) {
  const users = [];
  const fingerprints = [];
  const operations = [];
  const unknown = [];

  for (const line of splitLines(body)) {
    const upper = line.toUpperCase();

    if (upper.startsWith('USER ')) {
      const fields = parseKeyValueFields(line.slice(5));
      if (!fields.pin) continue;
      users.push({
        pin: fields.pin,
        name: fields.name || null,
        privilege: toIntOrNull(fields.pri) ?? 0,
        password: undefined, // never retained
        cardNumber: fields.card && fields.card !== '0' ? fields.card : null,
        group: fields.grp || null,
        raw: line,
      });
      continue;
    }

    if (upper.startsWith('FP ')) {
      const fields = parseKeyValueFields(line.slice(3));
      if (!fields.pin) continue;
      fingerprints.push({
        pin: fields.pin,
        fingerIndex: toIntOrNull(fields.fid) ?? 0,
        templateSize: toIntOrNull(fields.size),
        valid: toIntOrNull(fields.valid) ?? 1,
        isDuress: (toIntOrNull(fields.valid) ?? 1) === 3,
        // fields.tmp intentionally ignored — biometric templates stay on-device.
      });
      continue;
    }

    if (upper.startsWith('OPLOG ')) {
      const parts = line.slice(6).split('\t');
      operations.push({
        operationCode: toIntOrNull(parts[0]),
        operatorPin: (parts[1] ?? '').trim() || null,
        occurredAt: (parts[2] ?? '').trim() || null,
        target: (parts[3] ?? '').trim() || null,
        raw: line,
      });
      continue;
    }

    // USERPIC / BIODATA / FACE and friends carry biometric payloads we do not
    // store; record only that they were seen.
    unknown.push(line.split('\t')[0]);
  }

  return { users, fingerprints, operations, unknown };
}

/**
 * Parse the `table=OPTIONS` / device-info body the terminal posts at start-up,
 * e.g. "~DeviceName=IN01-A\r\nFPVersion=10\r\nUserCount=320".
 */
export function parseDeviceOptions(body) {
  const out = {};
  for (const line of splitLines(body)) {
    for (const chunk of line.split(/[\t,]/)) {
      const idx = chunk.indexOf('=');
      if (idx <= 0) continue;
      const key = chunk.slice(0, idx).trim().replace(/^~/, '').toLowerCase();
      out[key] = chunk.slice(idx + 1).trim();
    }
  }
  return out;
}

/**
 * Build the handshake configuration the terminal expects from
 * `GET /iclock/cdata?options=all`. The terminal parses these line by line and
 * silently ignores keys it does not understand, so extra keys are harmless but
 * a missing trailing newline is not.
 */
export function buildHandshakeResponse({
  serialNumber,
  attlogStamp = '0',
  operlogStamp = '0',
  errorDelaySeconds = 30,
  pollDelaySeconds = 10,
  transTimes = '00:00;14:05',
  transInterval = 1,
  // Which tables the device may push: ATTLOG, OPERLOG, ATTPHOTO, ...
  transFlag = '1111000000',
  realtime = 1,
  timezoneOffsetHours = 3,
  serverVersion = '2.4.1',
} = {}) {
  const lines = [
    `GET OPTION FROM: ${serialNumber}`,
    `Stamp=${attlogStamp}`,
    `OpStamp=${operlogStamp}`,
    `ErrorDelay=${errorDelaySeconds}`,
    `Delay=${pollDelaySeconds}`,
    `TransTimes=${transTimes}`,
    `TransInterval=${transInterval}`,
    `TransFlag=${transFlag}`,
    `Realtime=${realtime}`,
    `TimeZone=${timezoneOffsetHours}`,
    `Encrypt=0`,
    `ServerVer=${serverVersion}`,
  ];
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Serialise queued commands for `GET /iclock/getrequest`.
 * Wire format is one `C:<id>:<COMMAND>` per line; an empty queue answers "OK".
 */
export function buildCommandResponse(commands) {
  if (!commands || commands.length === 0) return 'OK\r\n';
  return `${commands.map((c) => `C:${c.id}:${c.command}`).join('\r\n')}\r\n`;
}

/**
 * Parse the body of `POST /iclock/devicecmd`, which acknowledges commands:
 *   "ID=123&Return=0&CMD=DATA" — or several such lines, one per command.
 * Return=0 means success; anything else is a device-side failure code.
 */
export function parseCommandAck(body) {
  const acks = [];
  for (const line of splitLines(body)) {
    const fields = {};
    for (const pair of line.split('&')) {
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      fields[pair.slice(0, idx).trim().toLowerCase()] = pair.slice(idx + 1).trim();
    }
    if (fields.id === undefined) continue;
    acks.push({
      commandId: toIntOrNull(fields.id),
      returnCode: toIntOrNull(fields.return) ?? 0,
      command: fields.cmd ?? null,
      raw: line,
    });
  }
  return acks;
}

/** The terminal treats any body starting with "OK" as success. */
export function okResponse(count) {
  return typeof count === 'number' ? `OK: ${count}\r\n` : 'OK\r\n';
}

export function describePunchState(state) {
  return PUNCH_STATES[state] ?? 'unknown';
}

export function describeVerifyMode(mode) {
  return VERIFY_MODES[mode] ?? 'unknown';
}

/** Verification methods that actually prove who was standing at the terminal. */
export const BIOMETRIC_VERIFY_MODES = [1, 15, 25]; // fingerprint, face, palm
const BIOMETRIC_MODES = new Set(BIOMETRIC_VERIFY_MODES);

/**
 * Known modes that are *not* a biometric check — a typed PIN or a card.
 *
 * Derived from the same table rather than listed separately, so a mode added
 * to VERIFY_MODES can never be silently missing from a filter built on this.
 */
export const NON_BIOMETRIC_VERIFY_MODES = Object.keys(VERIFY_MODES)
  .map(Number)
  .filter((mode) => !BIOMETRIC_MODES.has(mode));

/**
 * Whether a punch was verified biometrically.
 *
 * This is the distinction that matters for PRD §2: a terminal that permits
 * password or card fallback lets one student mark another present by typing
 * their PIN, which is exactly the proxy attendance the biometric system is
 * meant to eliminate. Returns null when the mode is unknown or absent, so
 * callers can tell "not biometric" apart from "no information".
 */
export function isBiometricVerification(mode) {
  if (mode === null || mode === undefined) return null;
  if (!(mode in VERIFY_MODES)) return null;
  return BIOMETRIC_MODES.has(Number(mode));
}
