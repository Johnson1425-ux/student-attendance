/**
 * Builders for the command strings a terminal executes when it polls
 * /iclock/getrequest. Kept separate from the wire codec so the vocabulary of
 * supported operations is in one readable place.
 *
 * Enrollment itself (capturing the fingerprint) is done at the terminal by
 * office staff — see docs/DEVICE-INTEGRATION.md. These commands cover the
 * management actions the dashboard can trigger remotely.
 */

const escapeField = (value) =>
  String(value ?? '')
    .replace(/[\t\r\n]/g, ' ')
    .trim();

/**
 * Create or update a user on the terminal. Used to push a student's PIN and
 * name to the device *before* staff capture the fingerprint, so the operator
 * only has to type the PIN and see the right name appear.
 */
export function updateUserInfo({ pin, name, privilege = 0, cardNumber = '', password = '' }) {
  const fields = [
    `PIN=${escapeField(pin)}`,
    `Name=${escapeField(name).slice(0, 24)}`,
    `Pri=${privilege}`,
    `Passwd=${escapeField(password)}`,
    `Card=${escapeField(cardNumber)}`,
    `Grp=1`,
    `TZ=0000000000000000`,
  ];
  return `DATA UPDATE USERINFO ${fields.join('\t')}`;
}

/** Remove a user (and their templates) from the terminal. */
export function deleteUser(pin) {
  return `DATA DELETE USERINFO PIN=${escapeField(pin)}`;
}

/** Remove one enrolled finger, leaving the user record in place. */
export function deleteFingerprint(pin, fingerIndex) {
  return `DATA DELETE FINGERTMP PIN=${escapeField(pin)}\tFID=${Number(fingerIndex)}`;
}

/** Ask the terminal to re-upload its full user list. */
export function queryUserInfo(pin) {
  return pin ? `DATA QUERY USERINFO PIN=${escapeField(pin)}` : 'DATA QUERY USERINFO';
}

/** Ask the terminal to re-upload attendance logs for a date range. */
export function queryAttendanceLogs(startDate, endDate) {
  return `DATA QUERY ATTLOG StartTime=${startDate} 00:00:00\tEndTime=${endDate} 23:59:59`;
}

/** Set the terminal clock, e.g. after a power loss. Time is device-local. */
export function setDeviceTime(localDateTime) {
  return `SET OPTIONS DateTime=${escapeField(localDateTime)}`;
}

/** Request device info (user counts, firmware) on the next poll. */
export function requestDeviceInfo() {
  return 'INFO';
}

/** Clear the terminal's stored attendance logs. Destructive — admin only. */
export function clearAttendanceLogs() {
  return 'CLEAR LOG';
}

/** Reboot the terminal. */
export function reboot() {
  return 'REBOOT';
}

/**
 * Whitelist of remotely triggerable commands, exposed by the devices API so the
 * dashboard cannot post arbitrary strings to a terminal.
 */
export const COMMAND_CATALOG = {
  info: { build: requestDeviceInfo, description: 'Request device status and counters', role: 'admin' },
  sync_user: { build: updateUserInfo, description: 'Push a student PIN and name to the terminal', role: 'office_staff' },
  delete_user: { build: deleteUser, description: 'Remove a student from the terminal', role: 'admin' },
  delete_finger: { build: deleteFingerprint, description: 'Remove one enrolled fingerprint', role: 'office_staff' },
  query_users: { build: queryUserInfo, description: 'Ask the terminal to re-upload its user list', role: 'admin' },
  query_attlog: { build: queryAttendanceLogs, description: 'Re-request attendance logs for a date range', role: 'admin' },
  set_time: { build: setDeviceTime, description: 'Set the terminal clock', role: 'admin' },
  clear_log: { build: clearAttendanceLogs, description: 'Clear stored attendance logs on the terminal', role: 'admin' },
  reboot: { build: reboot, description: 'Reboot the terminal', role: 'admin' },
};
