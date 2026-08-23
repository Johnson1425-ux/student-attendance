import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { Card, Loading, ErrorState, EmptyState, Modal, Field, Spinner, Pagination } from '../components/ui.jsx';
import { formatDate } from '../utils/format.js';

/**
 * Absentee alerts (PRD §7.8).
 *
 * The list is a call sheet: the guardian's phone number sits next to the
 * student, and marking an alert acknowledged records who followed it up.
 */
export default function AlertsPage() {
  const { permissions } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [status, setStatus] = useState('open');
  const [page, setPage] = useState(1);
  const [acting, setActing] = useState(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['alerts', status, page],
    queryFn: () => api.get('/api/alerts', { status, page, pageSize: 25 }),
    placeholderData: (previous) => previous,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }) => api.patch(`/api/alerts/${id}`, payload),
    onSuccess: () => {
      toast.success('Alert updated');
      setActing(null);
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) => toast.error(err),
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.post('/api/alerts/refresh', {}),
    onSuccess: (result) => {
      toast.success(`Recalculated ${result.evaluated} students — ${result.raised} new, ${result.resolved} resolved`);
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
    onError: (err) => toast.error(err),
  });

  if (isLoading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;

  return (
    <div className="stack">
      <Card>
        <div className="filter-bar">
          <Field label="Show">
            <select
              className="select"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="open">Open</option>
              <option value="acknowledged">Being followed up</option>
              <option value="resolved">Resolved</option>
              <option value="all">All</option>
            </select>
          </Field>
          {permissions.canEditAttendance && (
            <div className="filter-bar__actions">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => refreshMutation.mutate()}
                disabled={refreshMutation.isPending}
                title="Recalculate every student's absence streak against the current threshold"
              >
                {refreshMutation.isPending ? 'Recalculating…' : 'Recalculate'}
              </button>
            </div>
          )}
        </div>
      </Card>

      <Card flush>
        {data.data.length === 0 ? (
          <EmptyState
            title={status === 'open' ? 'No open alerts' : 'Nothing here'}
            description={
              status === 'open'
                ? 'No student is currently on a consecutive-absence streak.'
                : 'Try a different filter.'
            }
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Student</th>
                    <th>Class</th>
                    <th className="table__num">Days absent</th>
                    <th>Absent since</th>
                    <th>Guardian</th>
                    <th>Status</th>
                    {permissions.canEditAttendance && <th />}
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((alert) => (
                    <tr key={alert.id}>
                      <td>
                        <Link to={`/students/${alert.student_id}`} className="table__primary">
                          {alert.full_name}
                        </Link>
                        <div className="table__secondary">{alert.admission_number}</div>
                      </td>
                      <td className="no-wrap">{alert.class_name ?? '—'}</td>
                      <td className="table__num">
                        <span className="badge badge--absent">{alert.consecutive_days}</span>
                      </td>
                      <td className="no-wrap small">
                        {formatDate(alert.first_absent_date)}
                        <div className="table__secondary">last: {formatDate(alert.last_absent_date)}</div>
                      </td>
                      <td>
                        <div className="truncate" style={{ maxWidth: 150 }}>
                          {alert.guardian_name ?? '—'}
                        </div>
                        {alert.guardian_phone && (
                          <a href={`tel:${alert.guardian_phone}`} className="table__secondary">
                            {alert.guardian_phone}
                          </a>
                        )}
                      </td>
                      <td>
                        <span
                          className={`badge ${
                            alert.status === 'open'
                              ? 'badge--absent'
                              : alert.status === 'acknowledged'
                                ? 'badge--late'
                                : 'badge--present'
                          }`}
                        >
                          {alert.status === 'acknowledged' ? 'Following up' : alert.status}
                        </span>
                        {alert.acknowledged_by_name && (
                          <div className="table__secondary">by {alert.acknowledged_by_name}</div>
                        )}
                        {alert.notes && (
                          <div className="table__secondary truncate" style={{ maxWidth: 180 }} title={alert.notes}>
                            {alert.notes}
                          </div>
                        )}
                      </td>
                      {permissions.canEditAttendance && (
                        <td>
                          <div className="table__actions">
                            {alert.status !== 'resolved' && (
                              <button
                                type="button"
                                className="btn btn--sm"
                                onClick={() =>
                                  setActing({
                                    id: alert.id,
                                    name: alert.full_name,
                                    status: alert.status === 'open' ? 'acknowledged' : 'resolved',
                                    notes: alert.notes ?? '',
                                  })
                                }
                              >
                                Update
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination pagination={data.pagination} onChange={setPage} />
          </>
        )}
      </Card>

      {acting && (
        <Modal
          title={`Follow up — ${acting.name}`}
          onClose={() => setActing(null)}
          size="sm"
          footer={
            <>
              <button type="button" className="btn" onClick={() => setActing(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={updateMutation.isPending}
                onClick={() =>
                  updateMutation.mutate({
                    id: acting.id,
                    payload: { status: acting.status, notes: acting.notes.trim() || undefined },
                  })
                }
              >
                {updateMutation.isPending ? <Spinner /> : 'Save'}
              </button>
            </>
          }
        >
          <div className="stack">
            <Field
              label="Status"
              hint="“Following up” means someone is dealing with it; “resolved” closes the alert."
            >
              <select className="select" value={acting.status} onChange={(e) => setActing({ ...acting, status: e.target.value })}>
                <option value="acknowledged">Following up</option>
                <option value="resolved">Resolved</option>
                <option value="open">Reopen</option>
              </select>
            </Field>
            <Field label="Notes" hint="What was done — who was called, what they said.">
              <textarea
                className="textarea"
                value={acting.notes}
                placeholder="e.g. Called the guardian; student is unwell and will return Monday"
                onChange={(e) => setActing({ ...acting, notes: e.target.value })}
              />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
