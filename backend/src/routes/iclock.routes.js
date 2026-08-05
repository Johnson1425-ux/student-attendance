import { Router } from 'express';
import express from 'express';
import {
  parseAttlog,
  parseOperlog,
  parseDeviceOptions,
  parseCommandAck,
  buildHandshakeResponse,
  buildCommandResponse,
  okResponse,
} from '../lib/adms/protocol.js';
import * as devicesService from '../services/devices.service.js';
import { ingestPunches } from '../services/attendance.service.js';
import { getAttendanceConfig } from '../services/settings.service.js';
import { logger } from '../config/logger.js';
import { AppError } from '../lib/errors.js';

/**
 * Terminal-facing ADMS endpoints.
 *
 * These are not part of the JSON API and follow the device's rules, not ours:
 *
 *  - bodies are tab-separated text, not JSON;
 *  - responses are short plain-text strings, and the terminal only accepts a
 *    reply beginning with "OK";
 *  - status codes matter operationally. A 200 tells the terminal the batch is
 *    safely stored and it may delete its local copy, so we only answer 200 once
 *    the rows are committed. Anything else makes it retry later, which is
 *    exactly the behaviour we want during a database outage (PRD §8).
 *
 * Authentication is per-device: registered serial number, optional shared
 * secret in the URL, optional IP allowlist. See devices.service.authenticateDevice.
 */

const router = Router();

// ADMS posts text/plain (and sometimes no Content-Type at all). Accept anything
// and hand the handlers a raw string.
router.use(
  express.text({
    type: () => true,
    limit: '5mb',
    defaultCharset: 'utf-8',
  }),
);

/** Log every device interaction at debug level — invaluable during install. */
router.use((req, _res, next) => {
  logger.debug(
    { path: req.path, query: req.query, bytes: typeof req.body === 'string' ? req.body.length : 0 },
    'ADMS request',
  );
  next();
});

function deviceCredentials(req) {
  return {
    serialNumber: req.query.SN ?? req.query.sn ?? null,
    secret: req.query.key ?? req.query.secret ?? req.get('x-device-secret') ?? null,
    ip: req.ip,
  };
}

/**
 * ADMS clients cannot read a JSON error body, so failures are answered with a
 * plain-text line and the appropriate status code.
 */
function sendDeviceError(res, err) {
  const status = err instanceof AppError ? err.status : 500;
  res.status(status).type('text/plain').send(`ERROR: ${err.message}\r\n`);
}

/**
 * Handshake. The terminal calls this on boot and periodically afterwards; the
 * reply tells it which tables to push, how often, and where its sync stamps
 * stand.
 */
router.get('/cdata', async (req, res) => {
  try {
    const device = await devicesService.authenticateDevice(deviceCredentials(req));
    const config = await getAttendanceConfig();

    await devicesService.touchDevice(device.id, {
      firmware: req.query.pushver ?? null,
    });

    logger.info(
      { serial: device.serial_number, name: device.name, options: req.query.options },
      'Terminal handshake',
    );

    res
      .status(200)
      .type('text/plain')
      .send(
        buildHandshakeResponse({
          serialNumber: device.serial_number,
          attlogStamp: device.attlog_stamp,
          operlogStamp: device.operlog_stamp,
          timezoneOffsetHours: device.timezone_offset ?? offsetHoursFor(config.timezone),
        }),
      );
  } catch (err) {
    sendDeviceError(res, err);
  }
});

/** Current UTC offset in whole hours, for the terminal's TimeZone= setting. */
function offsetHoursFor(timezone) {
  try {
    const formatted = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' }).format(
      new Date(),
    );
    const match = formatted.match(/GMT([+-]\d{1,2})/);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

/**
 * Data push. `table` selects the payload kind:
 *   ATTLOG  — attendance punches (the main path)
 *   OPERLOG — user records and fingerprint enrollment metadata
 *   OPTIONS — device info and counters
 */
router.post('/cdata', async (req, res) => {
  let device;
  try {
    device = await devicesService.authenticateDevice(deviceCredentials(req));
  } catch (err) {
    return sendDeviceError(res, err);
  }

  const table = String(req.query.table ?? req.query.TABLE ?? '').toUpperCase();
  const body = typeof req.body === 'string' ? req.body : '';
  const stamp = req.query.Stamp ?? req.query.stamp ?? null;

  try {
    if (table === 'ATTLOG') {
      const { records, errors } = parseAttlog(body);
      if (errors.length) {
        logger.warn({ serial: device.serial_number, errors: errors.slice(0, 5) }, 'Skipped malformed ATTLOG lines');
      }

      const summary = await ingestPunches({ device, records });
      await devicesService.touchDevice(device.id, { attlogStamp: stamp });

      logger.info({ serial: device.serial_number, ...summary }, 'Ingested attendance batch');
      // The terminal counts a batch as delivered on "OK: <n>".
      return res.status(200).type('text/plain').send(okResponse(summary.received));
    }

    if (table === 'OPERLOG') {
      const { users, fingerprints, operations } = parseOperlog(body);

      if (users.length) await devicesService.upsertDeviceUsers(device.id, users);
      if (fingerprints.length) await devicesService.upsertBiometricEnrollments(device.id, fingerprints);
      await devicesService.touchDevice(device.id, { operlogStamp: stamp });

      logger.info(
        {
          serial: device.serial_number,
          users: users.length,
          fingerprints: fingerprints.length,
          operations: operations.length,
        },
        'Ingested operation log',
      );
      return res.status(200).type('text/plain').send(okResponse(users.length + fingerprints.length));
    }

    if (table === 'OPTIONS' || table === '') {
      const options = parseDeviceOptions(body);
      await devicesService.touchDevice(device.id, {
        firmware: options.fwversion ?? options.firmware ?? null,
        userCount: numberOrNull(options.usercount),
        fingerprintCount: numberOrNull(options.fpcount),
        transactionCount: numberOrNull(options.transactioncount),
      });
      logger.info({ serial: device.serial_number, options }, 'Terminal reported device options');
      return res.status(200).type('text/plain').send(okResponse());
    }

    // Photos, face templates and similar tables are acknowledged but not
    // stored — this system only needs the attendance ledger.
    logger.info({ serial: device.serial_number, table }, 'Acknowledged unhandled ADMS table');
    return res.status(200).type('text/plain').send(okResponse());
  } catch (err) {
    // Deliberately do NOT answer 200: the terminal keeps the batch and retries.
    logger.error({ err, serial: device.serial_number, table }, 'Failed to ingest device push');
    return sendDeviceError(res, err);
  }
});

function numberOrNull(value) {
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

/** Command poll. Answers "OK" when the queue is empty. */
router.get('/getrequest', async (req, res) => {
  try {
    const device = await devicesService.authenticateDevice(deviceCredentials(req));
    await devicesService.touchDevice(device.id);
    const commands = await devicesService.claimPendingCommands(device.id);
    if (commands.length) {
      logger.info({ serial: device.serial_number, count: commands.length }, 'Dispatched commands to terminal');
    }
    res.status(200).type('text/plain').send(buildCommandResponse(commands));
  } catch (err) {
    sendDeviceError(res, err);
  }
});

/** Command acknowledgement. */
router.post('/devicecmd', async (req, res) => {
  try {
    const device = await devicesService.authenticateDevice(deviceCredentials(req));
    const acks = parseCommandAck(typeof req.body === 'string' ? req.body : '');
    await devicesService.recordCommandAck(device.id, acks);
    await devicesService.touchDevice(device.id);
    logger.info({ serial: device.serial_number, acks }, 'Terminal acknowledged commands');
    res.status(200).type('text/plain').send(okResponse());
  } catch (err) {
    sendDeviceError(res, err);
  }
});

/** Liveness check the terminal issues between pushes. */
router.get('/ping', async (req, res) => {
  try {
    const device = await devicesService.authenticateDevice(deviceCredentials(req));
    await devicesService.touchDevice(device.id);
    res.status(200).type('text/plain').send(okResponse());
  } catch (err) {
    sendDeviceError(res, err);
  }
});

/**
 * Biometric bulk-upload endpoints. Acknowledged so the terminal stops retrying,
 * but nothing is stored: fingerprint templates must never leave the device
 * (PRD §8).
 */
router.post(['/fdata', '/rtdata', '/edata'], async (req, res) => {
  try {
    const device = await devicesService.authenticateDevice(deviceCredentials(req));
    await devicesService.touchDevice(device.id);
    logger.info({ serial: device.serial_number, path: req.path }, 'Discarded biometric payload (not stored by design)');
    res.status(200).type('text/plain').send(okResponse());
  } catch (err) {
    sendDeviceError(res, err);
  }
});

export default router;
