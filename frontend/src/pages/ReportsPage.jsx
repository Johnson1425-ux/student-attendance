import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { api } from '../api/client.js';
import { useToast } from '../context/ToastContext.jsx';
import { Card, Field, Loading, ErrorState, EmptyState, RateMeter, Spinner } from '../components/ui.jsx';
import { formatPercent, formatShortDate, isoToday, addDays, startOfWeek, startOfMonth } from '../utils/format.js';

/**
 * Reporting workspace (PRD §7.5).
 *
 * Each report is the same shape — filters, an on-screen table, and the same
 * data downloadable as CSV or PDF — so staff learn the screen once and every
 * report behaves the way they expect.
 */

const REPORTS = {
  summary: {
    label: 'By student',
    path: '/api/reports/range',
    description: 'Attendance totals per student over a date range.',
    file: 'attendance-summary',
  },
  by_class: {
    label: 'By class',
    path: '/api/reports/by-class',
    description: 'Roll-up per class, for comparing across the school.',
    file: 'class-attendance',
  },
  trend: {
    label: 'Daily trend',
    path: '/api/reports/trend',
    description: 'Attendance day by day across the period.',
    file: 'attendance-trend',
  },
  chronic: {
    label: 'Chronic absentees',
    path: '/api/reports/chronic-absentees',
    description: 'Students below an attendance threshold, with guardian contacts.',
    file: 'chronic-absentees',
  },
  lateness: {
    label: 'Lateness',
    path: '/api/reports/lateness',
    description: 'Students most often late, and by how much.',
    file: 'lateness',
  },
};

export default function ReportsPage() {
  const toast = useToast();
  const [reportKey, setReportKey] = useState('summary');
  const [range, setRange] = useState({ from: startOfMonth(isoToday()), to: isoToday() });
  const [classId, setClassId] = useState('');
  const [threshold, setThreshold] = useState(80);
  const [sort, setSort] = useState('name');
  const [downloading, setDownloading] = useState(null);

  const report = REPORTS[reportKey];

  const { data: classes } = useQuery({ queryKey: ['classes'], queryFn: () => api.get('/api/classes') });

  const params = {
    from: range.from,
    to: range.to,
    ...(reportKey === 'summary' ? { classId: classId || undefined, sort } : {}),
    ...(reportKey === 'trend' ? { classId: classId || undefined } : {}),
    ...(reportKey === 'chronic' ? { threshold } : {}),
  };

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['report', reportKey, params],
    queryFn: () => api.get(report.path, params),
  });

  const download = async (format) => {
    setDownloading(format);
    try {
      await api.download(report.path, { ...params, format }, `${report.file}.${format}`);
    } catch (err) {
      toast.error(err);
    } finally {
      setDownloading(null);
    }
  };

  const preset = (from, to) => setRange({ from, to });

  return (
    <div className="stack">
      <div className="tabs">
        {Object.entries(REPORTS).map(([key, config]) => (
          <button
            key={key}
            type="button"
            className={`tab ${reportKey === key ? 'is-active' : ''}`}
            onClick={() => setReportKey(key)}
          >
            {config.label}
          </button>
        ))}
      </div>

      <Card subtitle={report.description}>
        <div className="filter-bar">
          <Field label="From">
            <input className="input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
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

          {(reportKey === 'summary' || reportKey === 'trend') && (
            <Field label="Class">
              <select className="select" value={classId} onChange={(e) => setClassId(e.target.value)}>
                <option value="">All classes</option>
                {classes?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {reportKey === 'summary' && (
            <Field label="Sort by">
              <select className="select" value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="name">Name</option>
                <option value="rate_asc">Lowest attendance</option>
                <option value="rate_desc">Highest attendance</option>
                <option value="absences">Most absences</option>
                <option value="lateness">Most lateness</option>
              </select>
            </Field>
          )}

          {reportKey === 'chronic' && (
            <Field label="Below" hint="Attendance threshold">
              <input
                className="input"
                type="number"
                min="0"
                max="100"
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
            </Field>
          )}

          <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
            <button type="button" className="btn btn--sm" onClick={() => download('csv')} disabled={downloading}>
              {downloading === 'csv' ? <Spinner /> : 'CSV'}
            </button>
            <button type="button" className="btn btn--sm" onClick={() => download('pdf')} disabled={downloading}>
              {downloading === 'pdf' ? <Spinner /> : 'PDF'}
            </button>
          </div>
        </div>

        <div className="btn-group" style={{ marginTop: 12 }}>
          <button type="button" className="btn btn--sm" onClick={() => preset(isoToday(), isoToday())}>
            Today
          </button>
          <button type="button" className="btn btn--sm" onClick={() => preset(startOfWeek(isoToday()), isoToday())}>
            This week
          </button>
          <button type="button" className="btn btn--sm" onClick={() => preset(startOfMonth(isoToday()), isoToday())}>
            This month
          </button>
          <button type="button" className="btn btn--sm" onClick={() => preset(addDays(isoToday(), -30), isoToday())}>
            Last 30 days
          </button>
          <button type="button" className="btn btn--sm" onClick={() => preset(addDays(isoToday(), -90), isoToday())}>
            Last 90 days
          </button>
        </div>
      </Card>

      {isLoading ? (
        <Loading label="Building the report…" />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <ReportBody reportKey={reportKey} data={data} />
      )}
    </div>
  );
}

function ReportBody({ reportKey, data }) {
  const rows = data.rows ?? [];
  const coverage =
    data.effectiveTo && data.effectiveTo < data.to
      ? `${data.from} to ${data.effectiveTo} (to date) · ${data.schoolDays ?? '—'} school days`
      : `${data.from} to ${data.to} · ${data.schoolDays ?? '—'} school days`;

  if (rows.length === 0) {
    return (
      <Card subtitle={coverage}>
        <EmptyState
          title="Nothing to report"
          description="There is no attendance data for the selected period and filters."
        />
      </Card>
    );
  }

  if (reportKey === 'trend') {
    return (
      <Card title="Daily trend" subtitle={coverage}>
        <div className="chart-wrap" style={{ height: 300 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={formatShortDate}
                tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                tickLine={false}
              />
              <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  fontSize: 12,
                  color: 'var(--text)',
                }}
                labelFormatter={formatShortDate}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="present" stackId="a" fill="var(--present)" name="Present" isAnimationActive={false} />
              <Bar dataKey="late" stackId="a" fill="var(--late)" name="Late" isAnimationActive={false} />
              <Bar dataKey="excused" stackId="a" fill="var(--excused)" name="Excused" isAnimationActive={false} />
              <Bar dataKey="absent" stackId="a" fill="var(--absent)" name="Absent" radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
    );
  }

  if (reportKey === 'by_class') {
    return (
      <Card title="By class" subtitle={coverage} flush>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Class</th>
                <th className="table__num">Students</th>
                <th className="table__num">Present</th>
                <th className="table__num">Late</th>
                <th className="table__num">Absent</th>
                <th className="table__num">Excused</th>
                <th style={{ width: 180 }}>Attendance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.class_id}>
                  <td className="table__primary">{row.class_name}</td>
                  <td className="table__num">{row.student_count}</td>
                  <td className="table__num">{row.present_days}</td>
                  <td className="table__num">{row.late_days}</td>
                  <td className="table__num">{row.absent_days}</td>
                  <td className="table__num">{row.excused_days}</td>
                  <td>
                    <RateMeter rate={row.attendance_rate} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    );
  }

  if (reportKey === 'lateness') {
    return (
      <Card title="Lateness" subtitle={coverage} flush>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Student</th>
                <th>Class</th>
                <th className="table__num">Late days</th>
                <th className="table__num">Total minutes</th>
                <th className="table__num">Average</th>
                <th className="table__num">Attendance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.student_id}>
                  <td>
                    <Link to={`/students/${row.student_id}`} className="table__primary">
                      {row.full_name}
                    </Link>
                    <div className="table__secondary">{row.admission_number}</div>
                  </td>
                  <td className="no-wrap">{row.class_name ?? '—'}</td>
                  <td className="table__num strong">{row.late_days}</td>
                  <td className="table__num">{row.total_minutes_late}</td>
                  <td className="table__num">{row.average_minutes_late} min</td>
                  <td className="table__num">{formatPercent(row.attendance_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    );
  }

  if (reportKey === 'chronic') {
    return (
      <Card
        title="Students below the threshold"
        subtitle={`${coverage} · under ${data.threshold}%`}
        flush
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Student</th>
                <th>Class</th>
                <th>Guardian</th>
                <th className="table__num">Absent</th>
                <th className="table__num">School days</th>
                <th style={{ width: 180 }}>Attendance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.student_id}>
                  <td>
                    <Link to={`/students/${row.student_id}`} className="table__primary">
                      {row.full_name}
                    </Link>
                    <div className="table__secondary">{row.admission_number}</div>
                  </td>
                  <td className="no-wrap">{row.class_name ?? '—'}</td>
                  <td>
                    <div className="truncate" style={{ maxWidth: 150 }}>
                      {row.guardian_name ?? '—'}
                    </div>
                    <div className="table__secondary">{row.guardian_phone ?? '—'}</div>
                  </td>
                  <td className="table__num strong">{row.absent_days}</td>
                  <td className="table__num">{row.expected_days}</td>
                  <td>
                    <RateMeter rate={row.attendance_rate} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    );
  }

  // Default: per-student summary
  return (
    <>
      {data.totals && (
        <div className="stat-grid">
          <div className="stat" style={{ '--stat-color': 'var(--accent)' }}>
            <p className="stat__label">Students</p>
            <p className="stat__value">{data.totals.students}</p>
          </div>
          <div className="stat" style={{ '--stat-color': 'var(--present)' }}>
            <p className="stat__label">Present days</p>
            <p className="stat__value">{data.totals.present_days}</p>
          </div>
          <div className="stat" style={{ '--stat-color': 'var(--late)' }}>
            <p className="stat__label">Late days</p>
            <p className="stat__value">{data.totals.late_days}</p>
          </div>
          <div className="stat" style={{ '--stat-color': 'var(--absent)' }}>
            <p className="stat__label">Absent days</p>
            <p className="stat__value">{data.totals.absent_days}</p>
          </div>
          <div className="stat" style={{ '--stat-color': 'var(--excused)' }}>
            <p className="stat__label">Overall attendance</p>
            <p className="stat__value">{formatPercent(data.totals.attendance_rate)}</p>
          </div>
        </div>
      )}

      <Card title="By student" subtitle={coverage} flush>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Student</th>
                <th>Class</th>
                <th className="table__num">School days</th>
                <th className="table__num">Present</th>
                <th className="table__num">Late</th>
                <th className="table__num">Absent</th>
                <th className="table__num">Excused</th>
                <th style={{ width: 180 }}>Attendance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.student_id}>
                  <td>
                    <Link to={`/students/${row.student_id}`} className="table__primary">
                      {row.full_name}
                    </Link>
                    <div className="table__secondary">{row.admission_number}</div>
                  </td>
                  <td className="no-wrap">{row.class_name ?? '—'}</td>
                  <td className="table__num">{row.expected_days}</td>
                  <td className="table__num">{row.present_days}</td>
                  <td className="table__num">{row.late_days}</td>
                  <td className="table__num">{row.absent_days}</td>
                  <td className="table__num">{row.excused_days}</td>
                  <td>
                    <RateMeter rate={row.attendance_rate} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
