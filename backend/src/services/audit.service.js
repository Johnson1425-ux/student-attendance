import { query } from '../db/pool.js';
import { logger } from '../config/logger.js';

/**
 * Append-only activity log (PRD §3 "reliable audit trail").
 *
 * Writing an audit entry must never break the operation it describes: if the
 * log insert fails we record the problem and let the business action stand.
 * Losing an audit line is bad; losing a corrected attendance record is worse.
 */
export async function recordAudit(
  { actorId, actorLabel, action, entityType, entityId, summary, before, after, ip, userAgent },
  client,
) {
  const runner = client ?? { query };
  try {
    await runner.query(
      `INSERT INTO audit_logs
         (actor_id, actor_label, action, entity_type, entity_id, summary, before_data, after_data, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
      [
        actorId ?? null,
        actorLabel ?? null,
        action,
        entityType,
        entityId === undefined || entityId === null ? null : String(entityId),
        summary ?? null,
        before ? JSON.stringify(redact(before)) : null,
        after ? JSON.stringify(redact(after)) : null,
        ip ?? null,
        userAgent ?? null,
      ],
    );
  } catch (err) {
    logger.error({ err, action, entityType, entityId }, 'Failed to write audit log entry');
  }
}

const SENSITIVE_KEYS = new Set(['password', 'password_hash', 'push_secret', 'token', 'token_hash']);

function redact(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = Array.isArray(payload) ? [] : {};
  for (const [key, value] of Object.entries(payload)) {
    if (SENSITIVE_KEYS.has(key)) out[key] = '[redacted]';
    else if (value && typeof value === 'object' && !(value instanceof Date)) out[key] = redact(value);
    else out[key] = value;
  }
  return out;
}

/** Convenience wrapper for routes: pulls actor and request metadata off `req`. */
export function auditFromRequest(req, entry, client) {
  return recordAudit(
    {
      actorId: req.user?.id ?? null,
      actorLabel: req.user ? `${req.user.full_name} (${req.user.email})` : entry.actorLabel ?? 'system',
      ip: req.ip,
      userAgent: req.get?.('user-agent') ?? null,
      ...entry,
    },
    client,
  );
}

export async function listAuditLogs({
  page = 1,
  pageSize = 50,
  action,
  entityType,
  entityId,
  actorId,
  from,
  to,
} = {}) {
  const conditions = [];
  const params = [];

  const add = (sql, value) => {
    params.push(value);
    conditions.push(sql.replace('$?', `$${params.length}`));
  };

  if (action) add('a.action = $?', action);
  if (entityType) add('a.entity_type = $?', entityType);
  if (entityId) add('a.entity_id = $?', String(entityId));
  if (actorId) add('a.actor_id = $?', actorId);
  if (from) add('a.created_at >= $?::date', from);
  if (to) add("a.created_at < ($?::date + INTERVAL '1 day')", to);

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const { rows } = await query(
    `SELECT a.*, u.full_name AS actor_name, u.email AS actor_email,
            COUNT(*) OVER () AS total_count
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
       ${where}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  const total = rows.length ? Number(rows[0].total_count) : 0;
  return {
    data: rows.map(({ total_count, ...row }) => row),
    pagination: { page: Math.max(Number(page) || 1, 1), pageSize: limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function listAuditActions() {
  const { rows } = await query('SELECT DISTINCT action FROM audit_logs ORDER BY action');
  return rows.map((r) => r.action);
}
