import { Link, useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from 'recharts';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import {
  Card,
  Stat,
  StatusBadge,
  RateMeter,
  Loading,
  ErrorState,
  EmptyState,
  HealthIndicator,
  VerifyBadge,
} from '../components/ui.jsx';
import { formatTime, formatShortDate, formatRelative, formatPercent } from '../utils/format.js';

/**
 * The landing screen (PRD §7.4): who is in school right now, per class, plus
 * the two things that need someone's attention today — students on an absence
 * streak, and any terminal that has stopped reporting.
 *
 * It is one API call by design, so the whole page settles in a single
 * round-trip rather than a waterfall of a dozen.
 */
export default function DashboardPage() {
  const { permissions } = useAuth();
  const { settings } = useOutletContext();
  const timezone = settings?.timezone;

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get('/api/dashboard'),
    // The register fills up through the morning; a quiet poll keeps the wall
    // display current without anyone touching it.
    refetchInterval: 60_000,
  });

  if (isLoading) return <Loading label="Loading today’s attendance…" />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;

  const { summary, classes, recentEvents, alerts, trend, devices, dateLabel, isSchoolDay } = data;
  const offlineDevices = devices.filter((d) => d.health === 'offline' || d.health === 'never_connected');

  return (
    <div className="stack">
      <div className="row row--between row--wrap">
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 650, letterSpacing: '-0.02em' }}>{dateLabel}</h2>
          <p className="small muted">
            {isSchoolDay ? 'School day in progress' : 'Not a school day — attendance is not expected'}
          </p>
        </div>
        <button type="button" className="btn btn--sm" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {!isSchoolDay && (
        <div className="alert alert--info">
          Today is marked as a non-school day in the calendar, so nobody will be recorded absent.
        </div>
      )}

      {offlineDevices.length > 0 && (
        <div className="alert alert--warning">
          <div>
            <strong>
              {offlineDevices.length} terminal{offlineDevices.length === 1 ? '' : 's'} not reporting.
            </strong>{' '}
            Attendance is not being captured there. {offlineDevices.map((d) => d.name).join(', ')}.{' '}
            {permissions.canViewDevices && <Link to="/devices">Check terminals</Link>}
          </div>
        </div>
      )}

      <div className="stat-grid">
        <Stat label="Expected" value={summary.expected} hint="Students on roll today" color="var(--accent)" />
        <Stat
          label="In school"
          value={summary.inSchool}
          hint={`${formatPercent(summary.attendanceRate)} attendance`}
          color="var(--present)"
        />
        <Stat label="Late" value={summary.late} hint="Arrived after the cut-off" color="var(--late)" />
        <Stat
          label="Absent"
          value={summary.absent}
          hint={summary.not_marked > 0 ? `${summary.not_marked} not yet marked` : 'Day finalised'}
          color="var(--absent)"
        />
        <Stat label="Open alerts" value={alerts.open} hint="Consecutive absences" color="var(--excused)" />
      </div>

      <div className="grid-main-side">
        <div className="stack">
          <Card title="Attendance over the last two weeks" subtitle="Percentage of expected students in school">
            {trend.length === 0 ? (
              <EmptyState title="No data yet" description="Attendance will appear here once the terminal starts reporting." />
            ) : (
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trend} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
                    <defs>
                      <linearGradient id="rateFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.28} />
                        <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="var(--border)" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={formatShortDate}
                      tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                      tickLine={false}
                      axisLine={{ stroke: 'var(--border)' }}
                    />
                    <YAxis
                      domain={[0, 100]}
                      tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                      tickLine={false}
                      axisLine={false}
                      unit="%"
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        fontSize: 12,
                        color: 'var(--text)',
                      }}
                      labelFormatter={formatShortDate}
                      formatter={(value, name) => [name === 'attendance_rate' ? `${value}%` : value, 'Attendance']}
                    />
                    {/* 90% is the line most schools treat as the acceptable floor. */}
                    <ReferenceLine y={90} stroke="var(--present)" strokeDasharray="4 4" />
                    <Area
                      type="monotone"
                      dataKey="attendance_rate"
                      stroke="var(--accent)"
                      strokeWidth={2}
                      fill="url(#rateFill)"
                      // The dashboard re-polls every minute; re-animating the
                      // sweep on each refresh reads as the data changing.
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <Card title="By class" subtitle="Today" flush>
            {classes.length === 0 ? (
              <EmptyState title="No classes yet" description="Create a class and enrol students to see them here." />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Class</th>
                      <th className="table__num">Expected</th>
                      <th className="table__num">Present</th>
                      <th className="table__num">Late</th>
                      <th className="table__num">Absent</th>
                      <th style={{ width: 170 }}>Attendance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {classes.map((row) => (
                      <tr key={row.class_id}>
                        <td>
                          <Link to={`/attendance?classId=${row.class_id}`} className="table__primary">
                            {row.class_name}
                          </Link>
                          {row.not_marked > 0 && <div className="table__secondary">{row.not_marked} not yet marked</div>}
                        </td>
                        <td className="table__num">{row.expected}</td>
                        <td className="table__num">{row.present}</td>
                        <td className="table__num">{row.late}</td>
                        <td className="table__num">{row.absent}</td>
                        <td>
                          <RateMeter rate={row.attendanceRate} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="stack">
          <Card title="Latest arrivals" subtitle="Live from the terminals" flush>
            {recentEvents.length === 0 ? (
              <EmptyState title="No scans yet today" />
            ) : (
              <div className="event-feed">
                {recentEvents.map((event) => (
                  <div key={event.id} className="event">
                    <span className="event__time">{formatTime(event.event_time, timezone)}</span>
                    <div className="flex-1" style={{ minWidth: 0 }}>
                      <div className="truncate strong" style={{ fontSize: 13 }}>
                        {event.student_id ? `${event.first_name} ${event.last_name}` : `Unknown PIN ${event.device_user_pin}`}
                      </div>
                      <div className="table__secondary truncate">
                        {event.class_name ?? 'Not linked to a student'} · {event.device_name ?? 'terminal'}
                      </div>
                      {event.verify_method && (
                        <div style={{ marginTop: 2 }}>
                          <VerifyBadge method={event.verify_method} biometric={event.verified_biometrically} />
                        </div>
                      )}
                    </div>
                    {event.status && <StatusBadge status={event.status} />}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card
            title="Needs follow-up"
            subtitle={`${alerts.open} open alert${alerts.open === 1 ? '' : 's'}`}
            actions={
              <Link to="/alerts" className="btn btn--sm">
                View all
              </Link>
            }
            flush
          >
            {alerts.latest.length === 0 ? (
              <EmptyState title="Nothing outstanding" description="No student is on a consecutive-absence streak." />
            ) : (
              <div className="event-feed">
                {alerts.latest.map((alert) => (
                  <div key={alert.id} className="event">
                    <div className="flex-1" style={{ minWidth: 0 }}>
                      <Link to={`/students/${alert.student_id}`} className="truncate strong" style={{ fontSize: 13 }}>
                        {alert.full_name}
                      </Link>
                      <div className="table__secondary truncate">
                        {alert.class_name ?? '—'} · since {formatShortDate(alert.first_absent_date)}
                      </div>
                    </div>
                    <span className="badge badge--absent">{alert.consecutive_days} days</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {permissions.canViewDevices && devices.length > 0 && (
            <Card title="Terminals" flush>
              <div className="event-feed">
                {devices.map((device) => (
                  <div key={device.id} className="event">
                    <div className="flex-1" style={{ minWidth: 0 }}>
                      <div className="truncate strong" style={{ fontSize: 13 }}>
                        {device.name}
                      </div>
                      <div className="table__secondary truncate">
                        {device.location ?? '—'} · seen {formatRelative(device.minutes_since_seen)}
                      </div>
                    </div>
                    <HealthIndicator health={device.health} />
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
