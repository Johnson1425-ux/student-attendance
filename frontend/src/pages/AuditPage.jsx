import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { Card, Loading, ErrorState, EmptyState, Field, Pagination, Modal } from '../components/ui.jsx';
import { formatDateTime, isoToday, addDays } from '../utils/format.js';

/**
 * Activity log (PRD §3 "reliable audit trail").
 *
 * Every change to a record is listed with who made it and what it was before.
 * The before/after payload is available on demand rather than inline, so the
 * common case — scanning for who changed an attendance record — stays readable.
 */
export default function AuditPage() {
  const [filters, setFilters] = useState({ action: '', from: addDays(isoToday(), -30), to: isoToday(), page: 1 });
  const [inspecting, setInspecting] = useState(null);

  const { data: actions } = useQuery({ queryKey: ['audit-actions'], queryFn: () => api.get('/api/audit/actions') });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['audit', filters],
    queryFn: () =>
      api.get('/api/audit', {
        action: filters.action || undefined,
        from: filters.from,
        to: filters.to,
        page: filters.page,
        pageSize: 50,
      }),
    placeholderData: (previous) => previous,
  });

  if (isLoading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;

  return (
    <div className="stack">
      <Card>
        <div className="filter-bar">
          <Field label="Action">
            <select
              className="select"
              value={filters.action}
              onChange={(e) => setFilters({ ...filters, action: e.target.value, page: 1 })}
            >
              <option value="">All actions</option>
              {actions?.map((action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </select>
          </Field>
          <Field label="From">
            <input
              className="input"
              type="date"
              value={filters.from}
              onChange={(e) => setFilters({ ...filters, from: e.target.value, page: 1 })}
            />
          </Field>
          <Field label="To">
            <input
              className="input"
              type="date"
              value={filters.to}
              onChange={(e) => setFilters({ ...filters, to: e.target.value, page: 1 })}
            />
          </Field>
        </div>
      </Card>

      <Card flush>
        {data.data.length === 0 ? (
          <EmptyState title="No activity in this period" />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>Action</th>
                    <th>What happened</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((entry) => (
                    <tr key={entry.id}>
                      <td className="small muted no-wrap">{formatDateTime(entry.created_at)}</td>
                      <td className="small">
                        <div className="strong">{entry.actor_name ?? entry.actor_label ?? 'system'}</div>
                        {entry.actor_email && <div className="table__secondary">{entry.actor_email}</div>}
                      </td>
                      <td>
                        <span className="badge badge--accent mono" style={{ fontSize: 11 }}>
                          {entry.action}
                        </span>
                      </td>
                      <td className="small">{entry.summary ?? '—'}</td>
                      <td>
                        <div className="table__actions">
                          {(entry.before_data || entry.after_data) && (
                            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setInspecting(entry)}>
                              Details
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination pagination={data.pagination} onChange={(page) => setFilters({ ...filters, page })} />
          </>
        )}
      </Card>

      {inspecting && (
        <Modal title={inspecting.action} onClose={() => setInspecting(null)} size="lg">
          <div className="stack">
            <p className="small muted">
              {inspecting.summary} · {formatDateTime(inspecting.created_at)}
              {inspecting.ip_address ? ` · from ${inspecting.ip_address}` : ''}
            </p>
            {inspecting.before_data && (
              <div>
                <p className="field__label">Before</p>
                <pre className="mono" style={{ background: 'var(--surface-2)', padding: 12, borderRadius: 8, overflowX: 'auto' }}>
                  {JSON.stringify(inspecting.before_data, null, 2)}
                </pre>
              </div>
            )}
            {inspecting.after_data && (
              <div>
                <p className="field__label">After</p>
                <pre className="mono" style={{ background: 'var(--surface-2)', padding: 12, borderRadius: 8, overflowX: 'auto' }}>
                  {JSON.stringify(inspecting.after_data, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
