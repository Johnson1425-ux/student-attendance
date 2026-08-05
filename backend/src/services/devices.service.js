import { query, withTransaction } from '../db/pool.js';
import { NotFoundError, BadRequestError, ConflictError, ForbiddenError, mapDatabaseError } from '../lib/errors.js';
import { generateToken, safeEqual } from '../lib/password.js';
import { recordAudit } from './audit.service.js';
import { backfillEventsForPin } from './attendance.service.js';
import { COMMAND_CATALOG } from '../lib/adms/commands.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Fingerprint terminal registry and the enrollment link between a device PIN
 * and a student record (PRD §7.2).
 *
 * Enrollment itself happens at the terminal: office staff capture the finger
 * there, the device pushes a USERINFO row, and this service turns that row into
 * a link. The dashboard's job is to make unlinked enrollments visible and easy
 * to attach to the right student.
 */

const CONSTRAINT_MESSAGES = {
  devices_serial_number_key: 'A terminal with this serial number is already registered',
  biometric_finger_unique: 'That finger is already recorded for this student on this terminal',
};

const DEVICE_PUBLIC = `
  id, serial_number, name, location, model, firmware, timezone_offset, is_active,
  last_seen_at, last_push_at, attlog_stamp, operlog_stamp, user_count,
  fingerprint_count, transaction_count, ip_allowlist, created_at, updated_at,
  (push_secret IS NOT NULL) AS has_push_secret
`;

export async function listDevices() {
  const { rows } = await query(
    `SELECT ${DEVICE_PUBLIC},
            (SELECT COUNT(*) FROM device_commands dc WHERE dc.device_id = devices.id AND dc.status = 'pending')::int AS pending_commands,
            (SELECT COUNT(*) FROM device_users du WHERE du.device_id = devices.id)::int AS known_users,
            (SELECT COUNT(*) FROM device_users du WHERE du.device_id = devices.id AND du.student_id IS NULL)::int AS unlinked_users
       FROM devices ORDER BY name`,
  );
  return rows.map(withHealth);
}

/**
 * A terminal that has not called home is the single most important operational
 * signal in this system — silence means either the internet is down or the
 * device is off, and either way nobody's attendance is being recorded.
 */
function withHealth(device) {
  const lastSeen = device.last_seen_at ? new Date(device.last_seen_at).getTime() : null;
  const minutesSinceSeen = lastSeen ? Math.round((Date.now() - lastSeen) / 60_000) : null;
  let health = 'never_connected';
  if (minutesSinceSeen !== null) {
    if (minutesSinceSeen <= 15) health = 'online';
    else if (minutesSinceSeen <= 120) health = 'delayed';
    else health = 'offline';
  }
  return { ...device, minutes_since_seen: minutesSinceSeen, health };
}

export async function getDevice(id) {
  const { rows } = await query(`SELECT ${DEVICE_PUBLIC} FROM devices WHERE id = $1`, [id]);
  if (!rows[0]) throw new NotFoundError('Device');

  const { rows: commands } = await query(
    `SELECT dc.id, dc.command, dc.description, dc.status, dc.return_code, dc.created_at, dc.sent_at,
            dc.completed_at, u.full_name AS created_by_name
       FROM device_commands dc LEFT JOIN users u ON u.id = dc.created_by
      WHERE dc.device_id = $1 ORDER BY dc.id DESC LIMIT 25`,
    [id],
  );

  const { rows: recent } = await query(
    `SELECT ev.event_time, ev.device_user_pin, s.first_name, s.last_name
       FROM attendance_events ev LEFT JOIN students s ON s.id = ev.student_id
      WHERE ev.device_id = $1 ORDER BY ev.event_time DESC LIMIT 10`,
    [id],
  );

  return { ...withHealth(rows[0]), recent_commands: commands, recent_events: recent };
}

/**
 * Register a terminal. The generated push secret is shown once — it goes into
 * the device's ADMS server URL and cannot be read back afterwards.
 */
export async function registerDevice(data, { actor, ip, userAgent } = {}) {
  const pushSecret = data.generateSecret === false ? null : generateToken(18);
  try {
    const { rows } = await query(
      `INSERT INTO devices (serial_number, name, location, model, timezone_offset, push_secret, ip_allowlist, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, TRUE))
       RETURNING ${DEVICE_PUBLIC}`,
      [
        data.serialNumber.trim(),
        data.name,
        data.location ?? null,
        data.model ?? null,
        data.timezoneOffset ?? null,
        pushSecret,
        data.ipAllowlist ?? null,
        data.isActive,
      ],
    );

    await recordAudit({
      actorId: actor?.id,
      actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
      action: 'device.register',
      entityType: 'device',
      entityId: rows[0].id,
      summary: `Registered terminal ${rows[0].name} (${rows[0].serial_number})`,
      after: rows[0],
      ip,
      userAgent,
    });

    return { ...withHealth(rows[0]), pushSecret };
  } catch (err) {
    throw mapDatabaseError(err, CONSTRAINT_MESSAGES);
  }
}

const UPDATABLE = {
  name: 'name',
  location: 'location',
  model: 'model',
  timezoneOffset: 'timezone_offset',
  ipAllowlist: 'ip_allowlist',
  isActive: 'is_active',
};

export async function updateDevice(id, patch, { actor, ip, userAgent } = {}) {
  const assignments = [];
  const params = [id];
  for (const [field, column] of Object.entries(UPDATABLE)) {
    if (patch[field] === undefined) continue;
    params.push(patch[field]);
    assignments.push(`${column} = $${params.length}`);
  }
  if (!assignments.length) throw new BadRequestError('No changes supplied');

  const { rows } = await query(
    `UPDATE devices SET ${assignments.join(', ')} WHERE id = $1 RETURNING ${DEVICE_PUBLIC}`,
    params,
  );
  if (!rows[0]) throw new NotFoundError('Device');

  await recordAudit({
    actorId: actor?.id,
    actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
    action: 'device.update',
    entityType: 'device',
    entityId: id,
    summary: `Updated terminal ${rows[0].name}`,
    after: rows[0],
    ip,
    userAgent,
  });
  return withHealth(rows[0]);
}

export async function rotatePushSecret(id, { actor, ip, userAgent } = {}) {
  const pushSecret = generateToken(18);
  const { rows } = await query('UPDATE devices SET push_secret = $2 WHERE id = $1 RETURNING id, name, serial_number', [
    id,
    pushSecret,
  ]);
  if (!rows[0]) throw new NotFoundError('Device');

  await recordAudit({
    actorId: actor?.id,
    actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
    action: 'device.rotate_secret',
    entityType: 'device',
    entityId: id,
    summary: `Rotated push secret for ${rows[0].name}`,
    ip,
    userAgent,
  });
  return { ...rows[0], pushSecret };
}

export async function deleteDevice(id, { actor, ip, userAgent } = {}) {
  const { rows } = await query('DELETE FROM devices WHERE id = $1 RETURNING id, name, serial_number', [id]);
  if (!rows[0]) throw new NotFoundError('Device');
  await recordAudit({
    actorId: actor?.id,
    actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
    action: 'device.delete',
    entityType: 'device',
    entityId: id,
    summary: `Removed terminal ${rows[0].name} (${rows[0].serial_number})`,
    before: rows[0],
    ip,
    userAgent,
  });
  return rows[0];
}

// ---------------------------------------------------------------------------
// ADMS session handling
// ---------------------------------------------------------------------------

/**
 * Authenticate an inbound ADMS request.
 *
 * The protocol identifies a terminal only by serial number, which is printed on
 * the case and therefore not a secret. Three defences are layered on top:
 *   1. the serial must belong to a registered, active device;
 *   2. an optional per-device shared secret in the URL;
 *   3. an optional per-device IP allowlist.
 *
 * With DEVICE_AUTO_REGISTER on, an unknown serial is provisioned as an inactive
 * device instead — useful during installation, where the engineer needs the
 * serial to appear in the dashboard before they can configure it.
 */
export async function authenticateDevice({ serialNumber, secret, ip }) {
  if (!serialNumber) throw new BadRequestError('Missing device serial number (SN)');

  const { rows } = await query('SELECT * FROM devices WHERE serial_number = $1', [serialNumber.trim()]);
  let device = rows[0];

  if (!device) {
    if (!env.DEVICE_AUTO_REGISTER) {
      logger.warn({ serialNumber, ip }, 'Push from unregistered terminal rejected');
      throw new ForbiddenError('This terminal is not registered');
    }
    const { rows: created } = await query(
      `INSERT INTO devices (serial_number, name, location, is_active)
       VALUES ($1, $2, 'Pending setup', FALSE)
       ON CONFLICT (serial_number) DO UPDATE SET last_seen_at = now()
       RETURNING *`,
      [serialNumber.trim(), `Unconfigured terminal ${serialNumber.trim()}`],
    );
    device = created[0];
    logger.warn({ serialNumber }, 'Auto-registered a new terminal as inactive; an admin must activate it');
    throw new ForbiddenError('This terminal is registered but not yet activated by an administrator');
  }

  if (!device.is_active) throw new ForbiddenError('This terminal has been deactivated');

  if (device.push_secret) {
    if (!secret || !safeEqual(secret, device.push_secret)) {
      logger.warn({ serialNumber, ip }, 'Push rejected: bad device secret');
      throw new ForbiddenError('Invalid device credentials');
    }
  } else if (env.DEVICE_PUSH_SECRET_REQUIRED) {
    throw new ForbiddenError('This terminal has no push secret configured');
  }

  if (device.ip_allowlist?.length && ip && !device.ip_allowlist.includes(ip)) {
    logger.warn({ serialNumber, ip }, 'Push rejected: source IP not in allowlist');
    throw new ForbiddenError('Requests from this address are not allowed for this terminal');
  }

  return device;
}

export async function touchDevice(deviceId, patch = {}) {
  const assignments = ['last_seen_at = now()'];
  const params = [deviceId];
  const map = {
    firmware: 'firmware',
    userCount: 'user_count',
    fingerprintCount: 'fingerprint_count',
    transactionCount: 'transaction_count',
    attlogStamp: 'attlog_stamp',
    operlogStamp: 'operlog_stamp',
  };
  for (const [field, column] of Object.entries(map)) {
    if (patch[field] === undefined || patch[field] === null) continue;
    params.push(patch[field]);
    assignments.push(`${column} = $${params.length}`);
  }
  await query(`UPDATE devices SET ${assignments.join(', ')} WHERE id = $1`, params);
}

// ---------------------------------------------------------------------------
// Device users and biometric enrollment metadata
// ---------------------------------------------------------------------------

/**
 * Record users a terminal reports, and auto-link them to a student whose PIN
 * matches. Auto-linking is what makes the common path — office staff type the
 * admission-number PIN at the terminal — need no dashboard step at all.
 */
export async function upsertDeviceUsers(deviceId, users) {
  const linked = [];
  for (const user of users) {
    const { rows: studentRows } = await query('SELECT id FROM students WHERE device_user_pin = $1', [user.pin]);
    const studentId = studentRows[0]?.id ?? null;

    await query(
      `INSERT INTO device_users (device_id, pin, name, privilege, card_number, student_id, linked_at)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $6::bigint IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (device_id, pin) DO UPDATE SET
         name         = COALESCE(EXCLUDED.name, device_users.name),
         privilege    = EXCLUDED.privilege,
         card_number  = COALESCE(EXCLUDED.card_number, device_users.card_number),
         student_id   = COALESCE(device_users.student_id, EXCLUDED.student_id),
         linked_at    = COALESCE(device_users.linked_at, CASE WHEN EXCLUDED.student_id IS NULL THEN NULL ELSE now() END),
         last_seen_at = now()`,
      [deviceId, user.pin, user.name, user.privilege ?? 0, user.cardNumber ?? null, studentId],
    );

    if (studentId) {
      linked.push({ pin: user.pin, studentId });
      await backfillEventsForPin(user.pin, studentId);
    }
  }
  return linked;
}

/**
 * Record that a finger was enrolled on a terminal. Only metadata is stored —
 * the template itself was already discarded by the protocol parser.
 */
export async function upsertBiometricEnrollments(deviceId, fingerprints) {
  let stored = 0;
  for (const fp of fingerprints) {
    const { rows } = await query(
      `SELECT s.id FROM students s WHERE s.device_user_pin = $1
        UNION ALL
       SELECT du.student_id FROM device_users du
        WHERE du.device_id = $2 AND du.pin = $1 AND du.student_id IS NOT NULL
        LIMIT 1`,
      [fp.pin, deviceId],
    );
    const studentId = rows[0]?.id;
    if (!studentId) continue;

    await query(
      `INSERT INTO biometric_enrollments (student_id, device_id, finger_index, is_duress, template_size)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (student_id, device_id, finger_index) DO UPDATE SET
         template_size = EXCLUDED.template_size,
         is_duress     = EXCLUDED.is_duress,
         updated_at    = now()`,
      [studentId, deviceId, fp.fingerIndex, fp.isDuress ?? false, fp.templateSize ?? null],
    );
    stored += 1;
  }

  await query(
    `UPDATE device_users du
        SET fingerprint_count = (
          SELECT COUNT(*) FROM biometric_enrollments b
           WHERE b.device_id = du.device_id AND b.student_id = du.student_id
        )
      WHERE du.device_id = $1 AND du.student_id IS NOT NULL`,
    [deviceId],
  );

  return stored;
}

export async function listDeviceUsers({ deviceId, unlinkedOnly = false } = {}) {
  const params = [];
  const conditions = [];
  if (deviceId) {
    params.push(deviceId);
    conditions.push(`du.device_id = $${params.length}`);
  }
  if (unlinkedOnly) conditions.push('du.student_id IS NULL');
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT du.*, d.name AS device_name, d.serial_number,
            s.first_name, s.last_name, s.admission_number
       FROM device_users du
       JOIN devices d ON d.id = du.device_id
       LEFT JOIN students s ON s.id = du.student_id
       ${where}
      ORDER BY du.student_id IS NOT NULL, du.last_seen_at DESC`,
    params,
  );
  return rows;
}

/**
 * Attach a device user to a student. This also writes the PIN onto the student
 * record and claims any punches that arrived before the link existed, so a
 * student enrolled at the terminal on Monday and linked on Wednesday keeps
 * Monday's and Tuesday's attendance.
 */
export async function linkDeviceUser({ deviceUserId, studentId, actor, ip, userAgent }) {
  return withTransaction(async (client) => {
    const { rows: duRows } = await client.query(
      'SELECT du.*, d.name AS device_name FROM device_users du JOIN devices d ON d.id = du.device_id WHERE du.id = $1',
      [deviceUserId],
    );
    const deviceUser = duRows[0];
    if (!deviceUser) throw new NotFoundError('Device user');

    const { rows: studentRows } = await client.query(
      'SELECT id, first_name, last_name, device_user_pin FROM students WHERE id = $1',
      [studentId],
    );
    const student = studentRows[0];
    if (!student) throw new NotFoundError('Student');

    if (student.device_user_pin && student.device_user_pin !== deviceUser.pin) {
      throw new ConflictError(
        `${student.first_name} ${student.last_name} is already linked to PIN ${student.device_user_pin}. ` +
          'Clear that PIN first if the student was re-enrolled under a new one.',
      );
    }

    try {
      await client.query('UPDATE students SET device_user_pin = $2 WHERE id = $1', [studentId, deviceUser.pin]);
    } catch (err) {
      throw mapDatabaseError(err, {
        students_device_pin_unique: `PIN ${deviceUser.pin} is already assigned to a different student`,
      });
    }

    await client.query(
      'UPDATE device_users SET student_id = $2, linked_at = now(), linked_by = $3 WHERE id = $1',
      [deviceUserId, studentId, actor?.id ?? null],
    );

    await recordAudit(
      {
        actorId: actor?.id,
        actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
        action: 'device.link_user',
        entityType: 'student',
        entityId: studentId,
        summary: `Linked terminal PIN ${deviceUser.pin} on ${deviceUser.device_name} to ${student.first_name} ${student.last_name}`,
        after: { pin: deviceUser.pin, studentId },
        ip,
        userAgent,
      },
      client,
    );

    return { deviceUser, student };
  }).then(async (result) => {
    const dates = await backfillEventsForPin(result.deviceUser.pin, result.student.id);
    return { ...result, backfilledDates: dates };
  });
}

export async function unlinkDeviceUser(deviceUserId, { actor, ip, userAgent } = {}) {
  const { rows } = await query(
    'UPDATE device_users SET student_id = NULL, linked_at = NULL, linked_by = NULL WHERE id = $1 RETURNING *',
    [deviceUserId],
  );
  if (!rows[0]) throw new NotFoundError('Device user');
  await recordAudit({
    actorId: actor?.id,
    actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
    action: 'device.unlink_user',
    entityType: 'device_user',
    entityId: deviceUserId,
    summary: `Unlinked terminal PIN ${rows[0].pin}`,
    ip,
    userAgent,
  });
  return rows[0];
}

// ---------------------------------------------------------------------------
// Command queue
// ---------------------------------------------------------------------------

export async function queueCommand({ deviceId, type, args = {}, actor, ip, userAgent }) {
  const entry = COMMAND_CATALOG[type];
  if (!entry) throw new BadRequestError(`Unknown command "${type}"`);

  const { rows: deviceRows } = await query('SELECT id, name FROM devices WHERE id = $1', [deviceId]);
  if (!deviceRows[0]) throw new NotFoundError('Device');

  const command = buildCommandString(type, entry, args);

  const { rows } = await query(
    `INSERT INTO device_commands (device_id, command, description, created_by)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [deviceId, command, entry.description, actor?.id ?? null],
  );

  await recordAudit({
    actorId: actor?.id,
    actorLabel: actor ? `${actor.full_name} (${actor.email})` : 'system',
    action: 'device.queue_command',
    entityType: 'device',
    entityId: deviceId,
    summary: `Queued "${type}" for ${deviceRows[0].name}`,
    after: { type, command },
    ip,
    userAgent,
  });

  return rows[0];
}

function buildCommandString(type, entry, args) {
  switch (type) {
    case 'sync_user':
      if (!args.pin || !args.name) throw new BadRequestError('sync_user requires pin and name');
      return entry.build(args);
    case 'delete_user':
      if (!args.pin) throw new BadRequestError('delete_user requires pin');
      return entry.build(args.pin);
    case 'delete_finger':
      if (!args.pin || args.fingerIndex === undefined) {
        throw new BadRequestError('delete_finger requires pin and fingerIndex');
      }
      return entry.build(args.pin, args.fingerIndex);
    case 'query_users':
      return entry.build(args.pin);
    case 'query_attlog':
      if (!args.startDate || !args.endDate) throw new BadRequestError('query_attlog requires startDate and endDate');
      return entry.build(args.startDate, args.endDate);
    case 'set_time':
      if (!args.dateTime) throw new BadRequestError('set_time requires dateTime (YYYY-MM-DD HH:mm:ss)');
      return entry.build(args.dateTime);
    default:
      return entry.build();
  }
}

/** Hand pending commands to a polling terminal and mark them as sent. */
export async function claimPendingCommands(deviceId, limit = 10) {
  const { rows } = await query(
    `UPDATE device_commands SET status = 'sent', sent_at = now()
      WHERE id IN (
        SELECT id FROM device_commands
         WHERE device_id = $1 AND status = 'pending'
         ORDER BY id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, command`,
    [deviceId, limit],
  );
  return rows;
}

export async function recordCommandAck(deviceId, acks) {
  for (const ack of acks) {
    await query(
      `UPDATE device_commands
          SET status = CASE WHEN $3 = 0 THEN 'acked'::device_command_status ELSE 'failed'::device_command_status END,
              return_code = $3,
              response = $4,
              completed_at = now()
        WHERE id = $1 AND device_id = $2`,
      [ack.commandId, deviceId, ack.returnCode, ack.raw?.slice(0, 500) ?? null],
    );
  }
}

/** Commands a terminal never picked up are eventually abandoned. */
export async function expireStaleCommands(olderThanHours = 24) {
  const { rowCount } = await query(
    `UPDATE device_commands SET status = 'expired'
      WHERE status IN ('pending','sent') AND created_at < now() - ($1 || ' hours')::interval`,
    [String(olderThanHours)],
  );
  return rowCount;
}
