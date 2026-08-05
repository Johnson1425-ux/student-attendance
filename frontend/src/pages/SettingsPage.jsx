import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useToast } from '../context/ToastContext.jsx';
import { Card, Loading, ErrorState, Field, Spinner, Alert } from '../components/ui.jsx';

const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
];

// A short list beats a 400-entry timezone dropdown for a single-school
// deployment; anything else can be typed into the same field.
const COMMON_TIMEZONES = [
  'Africa/Dar_es_Salaam',
  'Africa/Nairobi',
  'Africa/Kampala',
  'Africa/Kigali',
  'Africa/Lagos',
  'Africa/Johannesburg',
  'Africa/Cairo',
  'Europe/London',
  'UTC',
];

/**
 * School settings (admin only). These values drive the attendance engine —
 * changing the late cut-off changes how every subsequent arrival is classified
 * — so the form states the consequence of each field rather than just its name.
 */
export default function SettingsPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['settings', 'full'],
    queryFn: () => api.get('/api/settings'),
  });

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const mutation = useMutation({
    mutationFn: (patch) => api.patch('/api/settings', patch),
    onSuccess: (updated) => {
      toast.success('Settings saved');
      setForm(updated);
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) => toast.error(err),
  });

  if (isLoading || !form) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const toggleDay = (day) => {
    const current = new Set(form.school_days_of_week);
    if (current.has(day)) current.delete(day);
    else current.add(day);
    set('school_days_of_week', [...current].sort());
  };

  const save = (event) => {
    event.preventDefault();
    mutation.mutate({
      school_name: form.school_name,
      timezone: form.timezone,
      school_start_time: form.school_start_time,
      late_after_time: form.late_after_time,
      school_days_of_week: form.school_days_of_week,
      consecutive_absence_threshold: Number(form.consecutive_absence_threshold),
      minimum_checkout_gap_minutes: Number(form.minimum_checkout_gap_minutes),
      auto_finalize_enabled: Boolean(form.auto_finalize_enabled),
      report_footer_note: form.report_footer_note ?? '',
    });
  };

  return (
    <form className="stack" onSubmit={save}>
      <Alert tone="info">
        These settings drive how attendance is calculated. Changes apply to punches recorded from now on; days already
        closed keep the classification they were given.
      </Alert>

      <Card title="School">
        <div className="form-grid">
          <Field label="School name" hint="Appears on the dashboard and on exported reports">
            <input className="input" value={form.school_name} onChange={(e) => set('school_name', e.target.value)} />
          </Field>
          <Field label="Timezone" hint="Decides which day a fingerprint scan belongs to">
            <input
              className="input"
              list="timezones"
              value={form.timezone}
              onChange={(e) => set('timezone', e.target.value)}
            />
            <datalist id="timezones">
              {COMMON_TIMEZONES.map((tz) => (
                <option key={tz} value={tz} />
              ))}
            </datalist>
          </Field>
          <Field label="Report footer note" full>
            <input
              className="input"
              value={form.report_footer_note ?? ''}
              onChange={(e) => set('report_footer_note', e.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card title="The school day">
        <div className="form-grid">
          <Field label="Start time" hint="Lateness is measured from this time">
            <input
              className="input"
              type="time"
              value={form.school_start_time}
              onChange={(e) => set('school_start_time', e.target.value)}
            />
          </Field>
          <Field label="Late after" hint="Arrivals after this are recorded as late">
            <input
              className="input"
              type="time"
              value={form.late_after_time}
              onChange={(e) => set('late_after_time', e.target.value)}
            />
          </Field>
          <Field label="School days" hint="Individual dates can be overridden in the calendar" full>
            <div className="btn-group">
              {WEEKDAYS.map((day) => {
                const active = form.school_days_of_week.includes(day.value);
                return (
                  <button
                    key={day.value}
                    type="button"
                    className={`btn btn--sm ${active ? 'btn--primary' : ''}`}
                    onClick={() => toggleDay(day.value)}
                    aria-pressed={active}
                  >
                    {day.label}
                  </button>
                );
              })}
            </div>
          </Field>
        </div>
      </Card>

      <Card title="Attendance rules">
        <div className="form-grid">
          <Field
            label="Absentee alert threshold"
            hint="Consecutive school days absent before an alert is raised"
          >
            <input
              className="input"
              type="number"
              min="1"
              max="60"
              value={form.consecutive_absence_threshold}
              onChange={(e) => set('consecutive_absence_threshold', e.target.value)}
            />
          </Field>
          <Field
            label="Minimum time before check-out (minutes)"
            hint="A later scan only counts as leaving after this much time in school"
          >
            <input
              className="input"
              type="number"
              min="0"
              max="1440"
              value={form.minimum_checkout_gap_minutes}
              onChange={(e) => set('minimum_checkout_gap_minutes', e.target.value)}
            />
          </Field>
          <Field label="Close days automatically" hint="Overnight, mark students who never scanned as absent">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={Boolean(form.auto_finalize_enabled)}
                onChange={(e) => set('auto_finalize_enabled', e.target.checked)}
              />
              Enabled
            </label>
          </Field>
        </div>
      </Card>

      <div className="row row--end">
        <button type="submit" className="btn btn--primary" disabled={mutation.isPending}>
          {mutation.isPending ? <Spinner /> : 'Save settings'}
        </button>
      </div>
    </form>
  );
}
