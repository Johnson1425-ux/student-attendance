import { useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { Card, Stat, StatusBadge, Loading, ErrorState, EmptyState, Field } from '../components/ui.jsx';
import { formatDate, formatTime, formatPercent, isoToday, addDays } from '../utils/format.js';

/**
 * A single student's record and attendance history — the screen staff open
 * when a guardian rings up to ask about their child.
 */
export default function StudentDetailPage() {
  const { id } = useParams();
  const { settings } = useOutletContext();
  const [range, setRange] = useState({ from: addDays(isoToday(), -30), to: isoToday() });

  const studentQuery = useQuery({ queryKey: ['student', id], queryFn: () => api.get(`/api/students/${id}`) });

  const historyQuery = useQuery({
    queryKey: ['student-history', id, range],
    queryFn: () => api.get(`/api/reports/student/${id}`, range),
  });

  if (studentQuery.isLoading) return <Loading />;
  if (studentQuery.error) return <ErrorState error={studentQuery.error} onRetry={studentQuery.refetch} />;

  const student = studentQuery.data;
  const report = historyQuery.data;

  return (
    <div className="stack">
      <div className="row row--between row--wrap">
        <div>
          <h2 style={{ fontSize: 19, fontWeight: 650, letterSpacing: '-0.02em' }}>{student.full_name}</h2>
          <p className="small muted">
            {student.admission_number} · {student.class_name ?? 'No class'} ·{' '}
            <span style={{ textTransform: 'capitalize' }}>{student.status}</span>
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Link to="/students" className="btn btn--sm">
            Back to students
          </Link>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => api.download(`/api/reports/student/${id}`, { ...range, format: 'pdf' })}
          >
            Export PDF
          </button>
        </div>
      </div>

      <div className="grid-main-side">
        <div className="stack">
          <Card>
            <div className="filter-bar">
              <Field label="From">
                <input
                  className="input"
                  type="date"
                  value={range.from}
                  onChange={(e) => setRange({ ...range, from: e.target.value })}
                />
              </Field>
              <Field label="To">
                <input
                  className="input"
                  type="date"
                  max={isoToday()}
                  value={range.to}
                  onChange={(e) => setRange({ ...range, to: e.target.value })}
                />
              </Field>
              <div className="btn-group" style={{ marginLeft: 'auto' }}>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => setRange({ from: addDays(isoToday(), -7), to: isoToday() })}
                >
                  Last 7 days
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => setRange({ from: addDays(isoToday(), -30), to: isoToday() })}
                >
                  Last 30 days
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => setRange({ from: addDays(isoToday(), -90), to: isoToday() })}
                >
                  Last term
                </button>
              </div>
            </div>
          </Card>

          {report && (
            <div className="stat-grid">
              <Stat label="School days" value={report.summary.expected_days} color="var(--accent)" />
              <Stat label="Present" value={report.summary.present} color="var(--present)" />
              <Stat label="Late" value={report.summary.late} color="var(--late)" />
              <Stat label="Absent" value={report.summary.absent} color="var(--absent)" />
              <Stat
                label="Attendance"
                value={formatPercent(report.summary.attendance_rate)}
                color="var(--excused)"
                hint={report.summary.total_minutes_late ? `${report.summary.total_minutes_late} min late in total` : undefined}
              />
            </div>
          )}

          <Card title="Attendance history" flush>
            {historyQuery.isLoading ? (
              <Loading />
            ) : !report || report.days.length === 0 ? (
              <EmptyState title="No school days in this range" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Status</th>
                      <th>Check-in</th>
                      <th>Check-out</th>
                      <th>Recorded by</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...report.days].reverse().map((day) => (
                      <tr key={day.attendance_date}>
                        <td className="no-wrap">{formatDate(day.attendance_date, { weekday: true })}</td>
                        <td>
                          <StatusBadge status={day.status} />
                          {day.minutes_late > 0 && <div className="table__secondary">{day.minutes_late} min late</div>}
                        </td>
                        <td className="nums">{formatTime(day.check_in_at, settings?.timezone)}</td>
                        <td className="nums">{formatTime(day.check_out_at, settings?.timezone)}</td>
                        <td className="small">
                          {day.is_manual_override ? (
                            <>
                              <span className="badge badge--accent">Manual</span>
                              {day.recorded_by_name && <div className="table__secondary">{day.recorded_by_name}</div>}
                            </>
                          ) : (
                            <span className="muted">{day.device_name ?? '—'}</span>
                          )}
                        </td>
                        <td className="small muted">{day.override_reason ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="stack">
          <Card title="Details">
            <dl className="stack stack--sm" style={{ margin: 0 }}>
              <DetailRow label="Admission number" value={student.admission_number} mono />
              <DetailRow label="Terminal PIN" value={student.device_user_pin ?? 'Not assigned'} mono />
              <DetailRow label="Class" value={student.class_name ?? 'Unassigned'} />
              <DetailRow label="Date of birth" value={student.date_of_birth ? formatDate(student.date_of_birth) : '—'} />
              <DetailRow label="Gender" value={student.gender ?? '—'} />
              <DetailRow label="Enrolled on" value={formatDate(student.enrolled_on)} />
              {student.exited_on && <DetailRow label="Left on" value={formatDate(student.exited_on)} />}
            </dl>
          </Card>

          <Card title="Guardian">
            <dl className="stack stack--sm" style={{ margin: 0 }}>
              <DetailRow label="Name" value={student.guardian_name ?? '—'} />
              <DetailRow label="Phone" value={student.guardian_phone ?? '—'} />
              <DetailRow label="Email" value={student.guardian_email ?? '—'} />
              <DetailRow label="Address" value={student.address ?? '—'} />
            </dl>
          </Card>

          <Card title="Fingerprint enrolment" subtitle="Templates stay on the terminal">
            {student.biometrics.length === 0 ? (
              <EmptyState
                title="Not enrolled"
                description="This student has no fingerprints registered, so the terminal cannot recognise them."
              />
            ) : (
              <div className="stack stack--sm">
                {student.biometrics.map((finger) => (
                  <div key={finger.id} className="row row--between">
                    <div>
                      <div className="strong small">Finger {finger.finger_index}</div>
                      <div className="table__secondary">{finger.device_name}</div>
                    </div>
                    <span className="badge badge--present">Enrolled</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {student.enrollment_history?.length > 1 && (
            <Card title="Class history">
              <div className="stack stack--sm">
                {student.enrollment_history.map((entry) => (
                  <div key={entry.id} className="row row--between">
                    <span className="small strong">{entry.class_name}</span>
                    <span className="table__secondary">
                      {formatDate(entry.start_date)} → {entry.end_date ? formatDate(entry.end_date) : 'now'}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value, mono = false }) {
  return (
    <div className="row row--between" style={{ gap: 12 }}>
      <dt className="small muted no-wrap">{label}</dt>
      <dd className={`small strong text-right ${mono ? 'mono' : ''}`} style={{ margin: 0 }}>
        {value}
      </dd>
    </div>
  );
}
