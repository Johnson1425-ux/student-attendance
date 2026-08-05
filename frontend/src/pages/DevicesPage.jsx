import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import {
  Card,
  Loading,
  ErrorState,
  EmptyState,
  Modal,
  Field,
  Spinner,
  Alert,
  HealthIndicator,
} from '../components/ui.jsx';
import { formatRelative, formatDateTime } from '../utils/format.js';

/**
 * Fingerprint terminal management (PRD §5 and §7.2).
 *
 * Two jobs live here. The first is operational: is each terminal still calling
 * home? Silence means attendance is not being captured, and it is the failure
 * mode most likely to go unnoticed. The second is enrolment: students enrolled
 * at the terminal arrive as unlinked PINs that someone has to attach to a
 * student record.
 */
export default function DevicesPage() {
  const { permissions } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState('devices');
  const [registering, setRegistering] = useState(false);
  const [secret, setSecret] = useState(null);
  const [linking, setLinking] = useState(null);
  const [commanding, setCommanding] = useState(null);

  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.get('/api/devices'),
    refetchInterval: 60_000,
  });

  const unlinkedQuery = useQuery({
    queryKey: ['device-users', 'unlinked'],
    queryFn: () => api.get('/api/devices/users', { unlinkedOnly: 'true' }),
  });

  const unmatchedQuery = useQuery({
    queryKey: ['unmatched-scans'],
    queryFn: () => api.get('/api/attendance/unmatched'),
  });

  const registerMutation = useMutation({
    mutationFn: (payload) => api.post('/api/devices', payload),
    onSuccess: (device) => {
      setRegistering(false);
      setSecret({ name: device.name, serial: device.serial_number, value: device.pushSecret });
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (err) => toast.error(err),
  });

  const rotateMutation = useMutation({
    mutationFn: (id) => api.post(`/api/devices/${id}/rotate-secret`, {}),
    onSuccess: (result) => {
      setSecret({ name: result.name, serial: result.serial_number, value: result.pushSecret });
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (err) => toast.error(err),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }) => api.patch(`/api/devices/${id}`, { isActive }),
    onSuccess: () => {
      toast.success('Terminal updated');
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (err) => toast.error(err),
  });

  const commandMutation = useMutation({
    mutationFn: ({ deviceId, type, args }) => api.post(`/api/devices/${deviceId}/commands`, { type, args }),
    onSuccess: () => {
      toast.success('Command queued — the terminal will run it on its next check-in');
      setCommanding(null);
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (err) => toast.error(err),
  });

  const linkMutation = useMutation({
    mutationFn: ({ deviceUserId, studentId }) => api.post(`/api/devices/users/${deviceUserId}/link`, { studentId }),
    onSuccess: (result) => {
      toast.success(result.message);
      setLinking(null);
      queryClient.invalidateQueries({ queryKey: ['device-users'] });
      queryClient.invalidateQueries({ queryKey: ['unmatched-scans'] });
      queryClient.invalidateQueries({ queryKey: ['students'] });
    },
    onError: (err) => toast.error(err),
  });

  if (devicesQuery.isLoading) return <Loading />;
  if (devicesQuery.error) return <ErrorState error={devicesQuery.error} onRetry={devicesQuery.refetch} />;

  const devices = devicesQuery.data;
  const unlinked = unlinkedQuery.data ?? [];
  const unmatched = unmatchedQuery.data ?? [];

  return (
    <div className="stack">
      <div className="tabs">
        <button type="button" className={`tab ${tab === 'devices' ? 'is-active' : ''}`} onClick={() => setTab('devices')}>
          Terminals ({devices.length})
        </button>
        <button
          type="button"
          className={`tab ${tab === 'enrolment' ? 'is-active' : ''}`}
          onClick={() => setTab('enrolment')}
        >
          Pending enrolments ({unlinked.length})
        </button>
        <button
          type="button"
          className={`tab ${tab === 'unmatched' ? 'is-active' : ''}`}
          onClick={() => setTab('unmatched')}
        >
          Unmatched scans ({unmatched.length})
        </button>
      </div>

      {tab === 'devices' && (
        <>
          {permissions.canManageDevices && (
            <div className="row row--end">
              <button type="button" className="btn btn--primary btn--sm" onClick={() => setRegistering(true)}>
                Register a terminal
              </button>
            </div>
          )}

          {devices.length === 0 ? (
            <Card>
              <EmptyState
                title="No terminals registered"
                description="Register the fingerprint terminal's serial number, then point its ADMS server setting at this backend."
                action={
                  permissions.canManageDevices && (
                    <button type="button" className="btn btn--primary" onClick={() => setRegistering(true)}>
                      Register a terminal
                    </button>
                  )
                }
              />
            </Card>
          ) : (
            <div className="grid-2">
              {devices.map((device) => (
                <Card
                  key={device.id}
                  title={device.name}
                  subtitle={device.location ?? 'No location set'}
                  actions={<HealthIndicator health={device.health} />}
                >
                  <div className="stack stack--sm">
                    <Row label="Serial number" value={<span className="mono">{device.serial_number}</span>} />
                    <Row label="Model" value={device.model ?? '—'} />
                    <Row label="Last seen" value={formatRelative(device.minutes_since_seen)} />
                    <Row label="Last data push" value={device.last_push_at ? formatDateTime(device.last_push_at) : 'never'} />
                    <Row label="Known users" value={`${device.known_users} (${device.unlinked_users} unlinked)`} />
                    <Row label="Pending commands" value={device.pending_commands} />
                    <Row
                      label="Push secret"
                      value={device.has_push_secret ? <span className="badge badge--present">Set</span> : <span className="badge badge--absent">Not set</span>}
                    />
                    <Row
                      label="Status"
                      value={
                        device.is_active ? (
                          <span className="badge badge--present">Active</span>
                        ) : (
                          <span className="badge badge--absent">Disabled</span>
                        )
                      }
                    />
                  </div>

                  {device.health !== 'online' && (
                    <div style={{ marginTop: 12 }}>
                      <Alert tone="warning">
                        {device.health === 'never_connected'
                          ? 'This terminal has never contacted the server. Check its ADMS server address and the school’s internet connection.'
                          : 'This terminal has not checked in recently. Attendance from it may be delayed or missing.'}
                      </Alert>
                    </div>
                  )}

                  {permissions.canManageDevices && (
                    <div className="btn-group" style={{ marginTop: 12 }}>
                      <button type="button" className="btn btn--sm" onClick={() => setCommanding(device)}>
                        Send command
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => rotateMutation.mutate(device.id)}
                        disabled={rotateMutation.isPending}
                      >
                        Rotate secret
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => toggleMutation.mutate({ id: device.id, isActive: !device.is_active })}
                      >
                        {device.is_active ? 'Disable' : 'Enable'}
                      </button>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'enrolment' && (
        <Card
          title="Enrolments waiting to be linked"
          subtitle="Users created at a terminal whose PIN does not match any student record"
          flush
        >
          {unlinked.length === 0 ? (
            <EmptyState
              title="Nothing waiting"
              description="Every user on the terminals is linked to a student record."
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>PIN</th>
                    <th>Name on terminal</th>
                    <th>Terminal</th>
                    <th>Fingerprints</th>
                    <th>First seen</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {unlinked.map((entry) => (
                    <tr key={entry.id}>
                      <td className="mono strong">{entry.pin}</td>
                      <td>{entry.name ?? '—'}</td>
                      <td>{entry.device_name}</td>
                      <td className="nums">{entry.fingerprint_count}</td>
                      <td className="small muted">{formatDateTime(entry.first_seen_at)}</td>
                      <td>
                        <div className="table__actions">
                          <button type="button" className="btn btn--sm" onClick={() => setLinking(entry)}>
                            Link to student
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
      )}

      {tab === 'unmatched' && (
        <Card
          title="Scans with no matching student"
          subtitle="Somebody is scanning with a PIN this system does not recognise"
          flush
        >
          {unmatched.length === 0 ? (
            <EmptyState title="No unmatched scans" description="Every scan has been attributed to a student." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>PIN</th>
                    <th>Terminal</th>
                    <th className="table__num">Scans</th>
                    <th>First seen</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {unmatched.map((row) => (
                    <tr key={`${row.device_user_pin}-${row.serial_number}`}>
                      <td className="mono strong">{row.device_user_pin}</td>
                      <td>{row.device_name ?? row.serial_number}</td>
                      <td className="table__num">{row.scan_count}</td>
                      <td className="small muted">{formatDateTime(row.first_seen)}</td>
                      <td className="small muted">{formatDateTime(row.last_seen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {registering && (
        <RegisterModal onClose={() => setRegistering(false)} onSubmit={registerMutation.mutate} busy={registerMutation.isPending} />
      )}

      {secret && <SecretModal secret={secret} onClose={() => setSecret(null)} />}

      {linking && <LinkModal entry={linking} onClose={() => setLinking(null)} onLink={linkMutation.mutate} busy={linkMutation.isPending} />}

      {commanding && (
        <CommandModal
          device={commanding}
          onClose={() => setCommanding(null)}
          onSend={commandMutation.mutate}
          busy={commandMutation.isPending}
        />
      )}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="row row--between" style={{ gap: 12 }}>
      <span className="small muted no-wrap">{label}</span>
      <span className="small strong text-right">{value}</span>
    </div>
  );
}

function RegisterModal({ onClose, onSubmit, busy }) {
  const [form, setForm] = useState({ serialNumber: '', name: '', location: '', model: 'ZKTeco IN01-A', timezoneOffset: 3 });

  return (
    <Modal
      title="Register a fingerprint terminal"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="device-form" className="btn btn--primary" disabled={busy}>
            {busy ? <Spinner /> : 'Register'}
          </button>
        </>
      }
    >
      <form
        id="device-form"
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ ...form, timezoneOffset: Number(form.timezoneOffset) });
        }}
      >
        <Alert tone="info">
          The serial number is printed on the terminal and also shown in its menu under{' '}
          <span className="mono">Device Info</span>. It must match exactly, or the terminal’s pushes will be refused.
        </Alert>
        <div className="form-grid">
          <Field label="Serial number *">
            <input
              className="input"
              required
              value={form.serialNumber}
              onChange={(e) => setForm({ ...form, serialNumber: e.target.value.trim() })}
            />
          </Field>
          <Field label="Name *" hint="How staff will refer to it">
            <input
              className="input"
              required
              placeholder="Main Gate Terminal"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Location">
            <input
              className="input"
              placeholder="Main entrance"
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
            />
          </Field>
          <Field label="Model">
            <input className="input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          </Field>
          <Field label="Timezone offset (hours)" hint="The offset configured on the device itself">
            <input
              className="input"
              type="number"
              min="-12"
              max="14"
              value={form.timezoneOffset}
              onChange={(e) => setForm({ ...form, timezoneOffset: e.target.value })}
            />
          </Field>
        </div>
      </form>
    </Modal>
  );
}

function SecretModal({ secret, onClose }) {
  const toast = useToast();
  const apiBase = import.meta.env.VITE_API_BASE_URL || window.location.origin;
  const url = `${apiBase}/iclock/`;

  return (
    <Modal
      title="Terminal push secret"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn--primary" onClick={onClose}>
          I have saved it
        </button>
      }
    >
      <div className="stack">
        <Alert tone="warning">
          This secret is shown once and cannot be retrieved later. Copy it now — if it is lost, rotate the secret and
          reconfigure the terminal.
        </Alert>
        <Field label={`Push secret for ${secret.name}`}>
          <input className="input mono" readOnly value={secret.value} onFocus={(e) => e.target.select()} />
        </Field>
        <Field label="Server path to enter on the terminal" hint="Comm. / Cloud Server settings on the device">
          <input className="input mono" readOnly value={`${url}?key=${secret.value}`} onFocus={(e) => e.target.select()} />
        </Field>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            navigator.clipboard?.writeText(secret.value).then(
              () => toast.success('Secret copied'),
              () => toast.error('Could not copy — select the text and copy manually'),
            );
          }}
        >
          Copy secret
        </button>
        <p className="small muted">
          Full step-by-step terminal configuration is in <span className="mono">docs/DEVICE-INTEGRATION.md</span>.
        </p>
      </div>
    </Modal>
  );
}

function LinkModal({ entry, onClose, onLink, busy }) {
  const [search, setSearch] = useState('');
  const [studentId, setStudentId] = useState('');

  const { data } = useQuery({
    queryKey: ['students', 'link-search', search],
    queryFn: () => api.get('/api/students', { search: search || undefined, hasBiometrics: 'false', pageSize: 25 }),
  });

  return (
    <Modal
      title={`Link terminal PIN ${entry.pin}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!studentId || busy}
            onClick={() => onLink({ deviceUserId: entry.id, studentId: Number(studentId) })}
          >
            {busy ? <Spinner /> : 'Link'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Alert tone="info">
          Linking assigns PIN <span className="mono">{entry.pin}</span> to the student and claims any scans already
          recorded under it, so no attendance is lost.
        </Alert>
        <Field label="Find the student" hint="Showing students who do not yet have fingerprints enrolled">
          <input
            className="input"
            autoFocus
            placeholder="Name or admission number"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </Field>
        <Field label="Student">
          <select className="select" size={8} value={studentId} onChange={(e) => setStudentId(e.target.value)}>
            {(data?.data ?? []).map((student) => (
              <option key={student.id} value={student.id}>
                {student.full_name} — {student.admission_number} ({student.class_name ?? 'no class'})
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

function CommandModal({ device, onClose, onSend, busy }) {
  const [type, setType] = useState('info');
  const [args, setArgs] = useState({ pin: '', name: '', fingerIndex: 0, startDate: '', endDate: '', dateTime: '' });

  const { data: catalog } = useQuery({
    queryKey: ['device-commands'],
    queryFn: () => api.get('/api/devices/commands/catalog'),
  });

  const needs = {
    sync_user: ['pin', 'name'],
    delete_user: ['pin'],
    delete_finger: ['pin', 'fingerIndex'],
    query_attlog: ['startDate', 'endDate'],
    set_time: ['dateTime'],
  }[type] ?? [];

  return (
    <Modal
      title={`Send a command to ${device.name}`}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() =>
              onSend({
                deviceId: device.id,
                type,
                args: Object.fromEntries(needs.map((key) => [key, args[key]])),
              })
            }
          >
            {busy ? <Spinner /> : 'Queue command'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Alert tone="info">
          Commands are queued, not sent immediately — the terminal collects them the next time it checks in.
        </Alert>
        <Field label="Command">
          <select className="select" value={type} onChange={(e) => setType(e.target.value)}>
            {(catalog ?? []).map((command) => (
              <option key={command.type} value={command.type}>
                {command.description}
              </option>
            ))}
          </select>
        </Field>
        {needs.includes('pin') && (
          <Field label="Terminal PIN">
            <input className="input" value={args.pin} onChange={(e) => setArgs({ ...args, pin: e.target.value.replace(/\D/g, '') })} />
          </Field>
        )}
        {needs.includes('name') && (
          <Field label="Name to show on the terminal" hint="Up to 24 characters">
            <input className="input" value={args.name} onChange={(e) => setArgs({ ...args, name: e.target.value })} />
          </Field>
        )}
        {needs.includes('fingerIndex') && (
          <Field label="Finger index" hint="0–9, as numbered on the terminal">
            <input
              className="input"
              type="number"
              min="0"
              max="9"
              value={args.fingerIndex}
              onChange={(e) => setArgs({ ...args, fingerIndex: Number(e.target.value) })}
            />
          </Field>
        )}
        {needs.includes('startDate') && (
          <>
            <Field label="From">
              <input className="input" type="date" value={args.startDate} onChange={(e) => setArgs({ ...args, startDate: e.target.value })} />
            </Field>
            <Field label="To">
              <input className="input" type="date" value={args.endDate} onChange={(e) => setArgs({ ...args, endDate: e.target.value })} />
            </Field>
          </>
        )}
        {needs.includes('dateTime') && (
          <Field label="Set the terminal clock to" hint="Format: YYYY-MM-DD HH:mm:ss, in the device's local time">
            <input
              className="input mono"
              placeholder="2026-08-05 07:00:00"
              value={args.dateTime}
              onChange={(e) => setArgs({ ...args, dateTime: e.target.value })}
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}
