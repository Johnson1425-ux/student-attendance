import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useToast } from '../context/ToastContext.jsx';
import { Card, Loading, ErrorState, EmptyState, Modal, Field, Spinner, Alert } from '../components/ui.jsx';
import { formatDate, isoToday, addDays } from '../utils/format.js';

const DAY_TYPE_LABELS = {
  school_day: 'School day',
  holiday: 'Holiday',
  break: 'Break',
  weekend: 'Weekend',
};

/**
 * School calendar (admin only).
 *
 * This is the denominator behind every attendance rate in the system: a day
 * marked as a holiday is excluded from expected attendance, from absence
 * streaks, and from every report. Getting the term dates in here before the
 * first report is run is what stops a mid-term break reading as truancy.
 */
export default function CalendarPage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [range, setRange] = useState({ from: `${isoToday().slice(0, 4)}-01-01`, to: `${isoToday().slice(0, 4)}-12-31` });
  const [adding, setAdding] = useState(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['calendar', range],
    queryFn: () => api.get('/api/calendar', range),
  });

  const upcoming = useQuery({
    queryKey: ['calendar-resolved'],
    queryFn: () => api.get('/api/calendar/resolved', { from: isoToday(), to: addDays(isoToday(), 13) }),
  });

  const saveMutation = useMutation({
    mutationFn: (payload) => api.post('/api/calendar', payload),
    onSuccess: (entries) => {
      toast.success(`Saved ${entries.length} day(s)`);
      setAdding(null);
      queryClient.invalidateQueries({ queryKey: ['calendar'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) => toast.error(err),
  });

  const deleteMutation = useMutation({
    mutationFn: (date) => api.delete(`/api/calendar/${date}`),
    onSuccess: () => {
      toast.success('Entry removed');
      queryClient.invalidateQueries({ queryKey: ['calendar'] });
    },
    onError: (err) => toast.error(err),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;

  return (
    <div className="stack">
      <Alert tone="info">
        Days marked here override the normal weekly pattern. Attendance is only expected — and absence only counted — on
        school days.
      </Alert>

      <Card>
        <div className="filter-bar">
          <Field label="From">
            <input className="input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          </Field>
          <Field label="To">
            <input className="input" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </Field>
          <div className="filter-bar__actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => setAdding({ date: isoToday(), endDate: '', dayType: 'holiday', label: '' })}
            >
              Add days
            </button>
          </div>
        </div>
      </Card>

      <div className="grid-main-side">
        <Card title="Calendar entries" subtitle={`${data.length} entr${data.length === 1 ? 'y' : 'ies'}`} flush>
          {data.length === 0 ? (
            <EmptyState
              title="No entries yet"
              description="Add public holidays and term breaks so they are excluded from attendance figures."
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Label</th>
                    <th>Added by</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.map((entry) => (
                    <tr key={entry.calendar_date}>
                      <td className="no-wrap">{formatDate(entry.calendar_date, { weekday: true })}</td>
                      <td>
                        <span className={`badge ${entry.day_type === 'school_day' ? 'badge--present' : 'badge--absent'}`}>
                          {DAY_TYPE_LABELS[entry.day_type]}
                        </span>
                      </td>
                      <td>{entry.label ?? '—'}</td>
                      <td className="small muted">{entry.created_by_name ?? '—'}</td>
                      <td>
                        <div className="table__actions">
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => deleteMutation.mutate(entry.calendar_date)}
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Next two weeks" subtitle="How each day will be treated" flush>
          {upcoming.isLoading ? (
            <Loading />
          ) : (
            <div className="event-feed">
              {(upcoming.data ?? []).map((day) => (
                <div key={day.date} className="event">
                  <div className="flex-1">
                    <div className="small strong">{formatDate(day.date, { weekday: true })}</div>
                    {day.label && <div className="table__secondary">{day.label}</div>}
                  </div>
                  <span className={`badge ${day.isSchoolDay ? 'badge--present' : ''}`}>
                    {day.isSchoolDay ? 'School day' : DAY_TYPE_LABELS[day.dayType]}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {adding && (
        <Modal
          title="Add calendar days"
          onClose={() => setAdding(null)}
          size="sm"
          footer={
            <>
              <button type="button" className="btn" onClick={() => setAdding(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={saveMutation.isPending}
                onClick={() =>
                  saveMutation.mutate({
                    date: adding.date,
                    endDate: adding.endDate || undefined,
                    dayType: adding.dayType,
                    label: adding.label || undefined,
                  })
                }
              >
                {saveMutation.isPending ? <Spinner /> : 'Save'}
              </button>
            </>
          }
        >
          <div className="stack">
            <Field label="From">
              <input className="input" type="date" value={adding.date} onChange={(e) => setAdding({ ...adding, date: e.target.value })} />
            </Field>
            <Field label="To" hint="Leave blank for a single day">
              <input
                className="input"
                type="date"
                value={adding.endDate}
                onChange={(e) => setAdding({ ...adding, endDate: e.target.value })}
              />
            </Field>
            <Field label="Type">
              <select className="select" value={adding.dayType} onChange={(e) => setAdding({ ...adding, dayType: e.target.value })}>
                <option value="holiday">Holiday — school closed</option>
                <option value="break">Break — school closed</option>
                <option value="school_day">School day — attendance expected</option>
                <option value="weekend">Weekend — school closed</option>
              </select>
            </Field>
            <Field label="Label" hint="Shown in the calendar list, e.g. “Union Day”">
              <input className="input" value={adding.label} onChange={(e) => setAdding({ ...adding, label: e.target.value })} />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
