import { useMemo, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import {
  Card,
  Stat,
  StatusBadge,
  Loading,
  ErrorState,
  EmptyState,
  Modal,
  Field,
  Spinner,
  Alert,
} from '../components/ui.jsx';
import { formatTime, formatPercent, isoToday } from '../utils/format.js';

/**
 * The daily register (PRD §7.4 and §7.6).
 *
 * The whole roster is shown, not just the students who scanned, so an absence
 * is visible as a gap in a list rather than as something you have to go looking
 * for. Corrections are made in place, and always carry a reason.
 */
export default function AttendancePage() {
  const { permissions } = useAuth();
  const { settings } = useOutletContext();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const date = searchParams.get('date') ?? isoToday();
  const classId = searchParams.get('classId') ?? '';
  const status = searchParams.get('status') ?? '';
  const [search, setSearch] = useState('');

  const [override, setOverride] = useState(null);
  const [bulk, setBulk] = useState(null);
  const [selected, setSelected] = useState(() => new Set());

  const setParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
    setSelected(new Set());
  };

  const { data: classes } = useQuery({ queryKey: ['classes'], queryFn: () => api.get('/api/classes') });

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['register', date, classId, status],
    queryFn: () => api.get('/api/attendance/register', { date, classId: classId || undefined, status: status || undefined }),
    refetchInterval: date === isoToday() ? 60_000 : false,
  });

  const rows = useMemo(() => {
    if (!data?.rows) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return data.rows;
    return data.rows.filter(
      (row) =>
        row.full_name.toLowerCase().includes(needle) ||
        row.admission_number.toLowerCase().includes(needle) ||
        (row.device_user_pin ?? '').includes(needle),
    );
  }, [data, search]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['register'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    queryClient.invalidateQueries({ queryKey: ['alerts'] });
  };

  const overrideMutation = useMutation({
    mutationFn: (payload) => api.post('/api/attendance/manual', payload),
    onSuccess: () => {
      toast.success('Attendance updated');
      setOverride(null);
      invalidate();
    },
    onError: (err) => toast.error(err),
  });

  const bulkMutation = useMutation({
    mutationFn: (payload) => api.post('/api/attendance/manual/bulk', payload),
    onSuccess: (result) => {
      toast.success(`Updated ${result.updated} student${result.updated === 1 ? '' : 's'}`);
      if (result.failed?.length) toast.error(`${result.failed.length} could not be updated`);
      setBulk(null);
      setSelected(new Set());
      invalidate();
    },
    onError: (err) => toast.error(err),
  });

  const clearMutation = useMutation({
    mutationFn: ({ studentId }) => api.delete(`/api/attendance/manual/${studentId}/${date}`),
    onSuccess: () => {
      toast.success('Correction removed; the terminal record now applies');
      invalidate();
    },
    onError: (err) => toast.error(err),
  });

  const finalizeMutation = useMutation({
    mutationFn: () => api.post('/api/attendance/finalize', { date }),
    onSuccess: (result) => {
      if (result.skipped) toast.info(`Nothing to close: ${result.reason.replace(/_/g, ' ')}`);
      else toast.success(`Day closed — ${result.markedAbsent} student(s) recorded absent`);
      invalidate();
    },
    onError: (err) => toast.error(err),
  });

  const toggleRow = (studentId) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(studentId)) next.delete(studentId);
      else next.add(studentId);
      return next;
    });
  };

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.student_id));

  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;

  const { summary } = data;

  return (
    <div className="stack">
      <Card>
        <div className="filter-bar">
          <Field label="Date">
            <input
              className="input"
              type="date"
              value={date}
              max={isoToday()}
              onChange={(e) => setParam('date', e.target.value)}
            />
          </Field>
          <Field label="Class">
            <select className="select" value={classId} onChange={(e) => setParam('classId', e.target.value)}>
              <option value="">All classes</option>
              {classes?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select className="select" value={status} onChange={(e) => setParam('status', e.target.value)}>
              <option value="">Any status</option>
              <option value="present">Present</option>
              <option value="late">Late</option>
              <option value="absent">Absent</option>
              <option value="excused">Excused</option>
              <option value="not_marked">Not marked</option>
            </select>
          </Field>
          <Field label="Find a student">
            <input
              className="input"
              placeholder="Name, admission no. or PIN"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
          <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
            <button type="button" className="btn btn--sm" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => api.download('/api/reports/daily', { date, classId: classId || undefined, format: 'csv' })}
            >
              Export CSV
            </button>
            {permissions.isAdmin && (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => finalizeMutation.mutate()}
                disabled={finalizeMutation.isPending}
                title="Mark every student who has not scanned as absent"
              >
                {finalizeMutation.isPending ? 'Closing…' : 'Close the day'}
              </button>
            )}
          </div>
        </div>
      </Card>

      <div className="stat-grid">
        <Stat label="Expected" value={summary.expected} color="var(--accent)" />
        <Stat label="Present" value={summary.present} color="var(--present)" />
        <Stat label="Late" value={summary.late} color="var(--late)" />
        <Stat label="Absent" value={summary.absent} color="var(--absent)" />
        <Stat label="Not marked" value={summary.not_marked} color="var(--unmarked)" />
        <Stat label="Attendance" value={formatPercent(summary.attendanceRate)} color="var(--excused)" />
      </div>

      {permissions.canEditAttendance && selected.size > 0 && (
        <Alert tone="info">
          <span className="flex-1">
            {selected.size} student{selected.size === 1 ? '' : 's'} selected
          </span>
          <button type="button" className="btn btn--sm" onClick={() => setBulk({ status: 'excused', reason: '' })}>
            Mark selected…
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </Alert>
      )}

      <Card
        title="Register"
        subtitle={`${rows.length} student${rows.length === 1 ? '' : 's'}`}
        flush
      >
        {rows.length === 0 ? (
          <EmptyState
            title="No students match"
            description="Try clearing the filters, or check that students are enrolled in a class."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {permissions.canEditAttendance && (
                    <th style={{ width: 34 }}>
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={allSelected}
                        onChange={() =>
                          setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.student_id)))
                        }
                      />
                    </th>
                  )}
                  <th>Student</th>
                  <th>Class</th>
                  <th>Status</th>
                  <th>Check-in</th>
                  <th>Check-out</th>
                  <th>Source</th>
                  {permissions.canEditAttendance && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.student_id}>
                    {permissions.canEditAttendance && (
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.full_name}`}
                          checked={selected.has(row.student_id)}
                          onChange={() => toggleRow(row.student_id)}
                        />
                      </td>
                    )}
                    <td>
                      <Link to={`/students/${row.student_id}`} className="table__primary">
                        {row.full_name}
                      </Link>
                      <div className="table__secondary">
                        {row.admission_number}
                        {row.device_user_pin ? ` · PIN ${row.device_user_pin}` : ' · no PIN'}
                      </div>
                    </td>
                    <td className="no-wrap">{row.class_name}</td>
                    <td>
                      <StatusBadge status={row.status} />
                      {row.minutes_late > 0 && <div className="table__secondary">{row.minutes_late} min late</div>}
                    </td>
                    <td className="nums no-wrap">{formatTime(row.check_in_at, settings?.timezone)}</td>
                    <td className="nums no-wrap">{formatTime(row.check_out_at, settings?.timezone)}</td>
                    <td>
                      {row.is_manual_override ? (
                        <span className="badge badge--accent" title={row.override_reason ?? ''}>
                          Manual
                        </span>
                      ) : row.status === 'not_marked' ? (
                        <span className="subtle small">—</span>
                      ) : (
                        <span className="small muted">{row.device_name ?? row.source}</span>
                      )}
                      {row.recorded_by_name && <div className="table__secondary">by {row.recorded_by_name}</div>}
                    </td>
                    {permissions.canEditAttendance && (
                      <td>
                        <div className="table__actions">
                          {row.is_manual_override && (
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              onClick={() => clearMutation.mutate({ studentId: row.student_id })}
                              title="Remove the correction and use what the terminal recorded"
                            >
                              Undo
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn--sm"
                            onClick={() =>
                              setOverride({
                                studentId: row.student_id,
                                name: row.full_name,
                                status: row.status === 'not_marked' ? 'present' : row.status,
                                reason: '',
                                checkInTime: '',
                              })
                            }
                          >
                            Correct
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {override && (
        <Modal
          title={`Correct attendance — ${override.name}`}
          onClose={() => setOverride(null)}
          size="sm"
          footer={
            <>
              <button type="button" className="btn" onClick={() => setOverride(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!override.reason.trim() || overrideMutation.isPending}
                onClick={() =>
                  overrideMutation.mutate({
                    studentId: override.studentId,
                    date,
                    status: override.status,
                    reason: override.reason.trim(),
                    checkInTime: override.checkInTime || undefined,
                  })
                }
              >
                {overrideMutation.isPending ? <Spinner /> : 'Save correction'}
              </button>
            </>
          }
        >
          <div className="stack">
            <Alert tone="info">
              This correction is recorded against your account and will not be overwritten by the terminal.
            </Alert>
            <Field label="Status">
              <select
                className="select"
                value={override.status}
                onChange={(e) => setOverride({ ...override, status: e.target.value })}
              >
                <option value="present">Present</option>
                <option value="late">Late</option>
                <option value="absent">Absent</option>
                <option value="excused">Excused</option>
              </select>
            </Field>
            {override.status !== 'absent' && (
              <Field label="Arrival time" hint="Optional — leave blank if it is not known">
                <input
                  className="input"
                  type="time"
                  value={override.checkInTime}
                  onChange={(e) => setOverride({ ...override, checkInTime: e.target.value })}
                />
              </Field>
            )}
            <Field label="Reason" hint="Required. Explains why the terminal record is being changed.">
              <textarea
                className="textarea"
                value={override.reason}
                placeholder="e.g. Fingerprint would not read; verified at the office"
                onChange={(e) => setOverride({ ...override, reason: e.target.value })}
              />
            </Field>
          </div>
        </Modal>
      )}

      {bulk && (
        <Modal
          title={`Mark ${selected.size} student${selected.size === 1 ? '' : 's'}`}
          onClose={() => setBulk(null)}
          size="sm"
          footer={
            <>
              <button type="button" className="btn" onClick={() => setBulk(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!bulk.reason.trim() || bulkMutation.isPending}
                onClick={() =>
                  bulkMutation.mutate({
                    studentIds: [...selected],
                    date,
                    status: bulk.status,
                    reason: bulk.reason.trim(),
                  })
                }
              >
                {bulkMutation.isPending ? <Spinner /> : 'Apply to all'}
              </button>
            </>
          }
        >
          <div className="stack">
            <Field label="Status">
              <select className="select" value={bulk.status} onChange={(e) => setBulk({ ...bulk, status: e.target.value })}>
                <option value="present">Present</option>
                <option value="late">Late</option>
                <option value="absent">Absent</option>
                <option value="excused">Excused</option>
              </select>
            </Field>
            <Field label="Reason">
              <textarea
                className="textarea"
                value={bulk.reason}
                placeholder="e.g. Inter-school sports fixture"
                onChange={(e) => setBulk({ ...bulk, reason: e.target.value })}
              />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
