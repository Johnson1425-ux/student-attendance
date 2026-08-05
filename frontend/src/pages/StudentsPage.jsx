import { useState } from 'react';
import { Link } from 'react-router-dom';
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
  Pagination,
  Alert,
} from '../components/ui.jsx';

const EMPTY_STUDENT = {
  admissionNumber: '',
  firstName: '',
  middleName: '',
  lastName: '',
  deviceUserPin: '',
  dateOfBirth: '',
  gender: '',
  guardianName: '',
  guardianPhone: '',
  guardianEmail: '',
  address: '',
  classId: '',
  notes: '',
};

/**
 * Student roll (PRD §7.1).
 *
 * The list doubles as the enrollment worklist: the "fingerprints" column shows
 * at a glance who still needs to be enrolled at the terminal, which is the
 * usual reason a student silently never appears in the register.
 */
export default function StudentsPage() {
  const { permissions } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState({ search: '', classId: '', status: 'active', hasBiometrics: '', page: 1 });
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(false);

  const { data: classes } = useQuery({ queryKey: ['classes'], queryFn: () => api.get('/api/classes') });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['students', filters],
    queryFn: () =>
      api.get('/api/students', {
        search: filters.search || undefined,
        classId: filters.classId || undefined,
        status: filters.status,
        hasBiometrics: filters.hasBiometrics || undefined,
        page: filters.page,
        pageSize: 25,
      }),
    placeholderData: (previous) => previous,
  });

  const saveMutation = useMutation({
    mutationFn: ({ id, payload }) => (id ? api.patch(`/api/students/${id}`, payload) : api.post('/api/students', payload)),
    onSuccess: (_, variables) => {
      toast.success(variables.id ? 'Student updated' : 'Student added');
      setEditing(null);
      queryClient.invalidateQueries({ queryKey: ['students'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) => toast.error(err),
  });

  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));

  const openCreate = () => setEditing({ ...EMPTY_STUDENT, classId: filters.classId || '' });

  const openEdit = (student) =>
    setEditing({
      id: student.id,
      admissionNumber: student.admission_number ?? '',
      firstName: student.first_name ?? '',
      middleName: student.middle_name ?? '',
      lastName: student.last_name ?? '',
      deviceUserPin: student.device_user_pin ?? '',
      dateOfBirth: student.date_of_birth ?? '',
      gender: student.gender ?? '',
      guardianName: student.guardian_name ?? '',
      guardianPhone: student.guardian_phone ?? '',
      guardianEmail: student.guardian_email ?? '',
      address: student.address ?? '',
      classId: student.class_id ?? '',
      notes: student.notes ?? '',
    });

  const submit = (event) => {
    event.preventDefault();
    const { id, ...form } = editing;
    // Empty strings mean "not provided" in these forms; send null so the API
    // clears the column rather than storing a blank.
    const payload = Object.fromEntries(
      Object.entries(form).map(([key, value]) => [key, value === '' ? null : value]),
    );
    payload.classId = form.classId ? Number(form.classId) : null;
    saveMutation.mutate({ id, payload });
  };

  if (isLoading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;

  return (
    <div className="stack">
      <Card>
        <div className="filter-bar">
          <Field label="Search">
            <input
              className="input"
              placeholder="Name, admission no., PIN or guardian"
              value={filters.search}
              onChange={(e) => setFilter({ search: e.target.value })}
            />
          </Field>
          <Field label="Class">
            <select className="select" value={filters.classId} onChange={(e) => setFilter({ classId: e.target.value })}>
              <option value="">All classes</option>
              {classes?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select className="select" value={filters.status} onChange={(e) => setFilter({ status: e.target.value })}>
              <option value="active">On roll</option>
              <option value="inactive">Inactive</option>
              <option value="graduated">Graduated</option>
              <option value="transferred">Transferred</option>
              <option value="all">All</option>
            </select>
          </Field>
          <Field label="Fingerprints">
            <select
              className="select"
              value={filters.hasBiometrics}
              onChange={(e) => setFilter({ hasBiometrics: e.target.value })}
            >
              <option value="">Any</option>
              <option value="true">Enrolled</option>
              <option value="false">Not enrolled</option>
            </select>
          </Field>
          {permissions.canManageStudents && (
            <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
              <button type="button" className="btn btn--sm" onClick={() => setImporting(true)}>
                Import CSV
              </button>
              <button type="button" className="btn btn--primary btn--sm" onClick={openCreate}>
                Add student
              </button>
            </div>
          )}
        </div>
      </Card>

      <Card flush>
        {data.data.length === 0 ? (
          <EmptyState
            title="No students found"
            description="Adjust the filters, or add the first student to get started."
            action={
              permissions.canManageStudents && (
                <button type="button" className="btn btn--primary" onClick={openCreate}>
                  Add student
                </button>
              )
            }
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Student</th>
                    <th>Admission no.</th>
                    <th>Class</th>
                    <th>Terminal PIN</th>
                    <th>Fingerprints</th>
                    <th>Guardian</th>
                    <th>Status</th>
                    {permissions.canManageStudents && <th />}
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((student) => (
                    <tr key={student.id}>
                      <td>
                        <Link to={`/students/${student.id}`} className="table__primary">
                          {student.full_name}
                        </Link>
                      </td>
                      <td className="mono">{student.admission_number}</td>
                      <td className="no-wrap">{student.class_name ?? <span className="subtle">Unassigned</span>}</td>
                      <td className="mono">{student.device_user_pin ?? <span className="subtle">—</span>}</td>
                      <td>
                        {student.fingerprints_enrolled > 0 ? (
                          <span className="badge badge--present">{student.fingerprints_enrolled} enrolled</span>
                        ) : (
                          <span className="badge badge--absent">Not enrolled</span>
                        )}
                      </td>
                      <td>
                        {student.guardian_name ? (
                          <>
                            <div className="truncate" style={{ maxWidth: 160 }}>
                              {student.guardian_name}
                            </div>
                            <div className="table__secondary">{student.guardian_phone ?? '—'}</div>
                          </>
                        ) : (
                          <span className="subtle">—</span>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${student.status === 'active' ? 'badge--present' : ''}`}>
                          {student.status}
                        </span>
                      </td>
                      {permissions.canManageStudents && (
                        <td>
                          <div className="table__actions">
                            <button type="button" className="btn btn--sm" onClick={() => openEdit(student)}>
                              Edit
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination pagination={data.pagination} onChange={(page) => setFilters((f) => ({ ...f, page }))} />
          </>
        )}
      </Card>

      {editing && (
        <Modal
          title={editing.id ? `Edit ${editing.firstName} ${editing.lastName}` : 'Add a student'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" form="student-form" className="btn btn--primary" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? <Spinner /> : 'Save'}
              </button>
            </>
          }
        >
          <form id="student-form" onSubmit={submit} className="stack">
            <div className="form-grid">
              <Field label="Admission number *">
                <input
                  className="input"
                  required
                  value={editing.admissionNumber}
                  onChange={(e) => setEditing({ ...editing, admissionNumber: e.target.value })}
                />
              </Field>
              <Field
                label="Terminal PIN"
                hint="The numeric ID typed at the fingerprint terminal. Leave blank until enrolment."
              >
                <input
                  className="input"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={editing.deviceUserPin}
                  onChange={(e) => setEditing({ ...editing, deviceUserPin: e.target.value.replace(/\D/g, '') })}
                />
              </Field>
              <Field label="First name *">
                <input
                  className="input"
                  required
                  value={editing.firstName}
                  onChange={(e) => setEditing({ ...editing, firstName: e.target.value })}
                />
              </Field>
              <Field label="Middle name">
                <input
                  className="input"
                  value={editing.middleName}
                  onChange={(e) => setEditing({ ...editing, middleName: e.target.value })}
                />
              </Field>
              <Field label="Last name *">
                <input
                  className="input"
                  required
                  value={editing.lastName}
                  onChange={(e) => setEditing({ ...editing, lastName: e.target.value })}
                />
              </Field>
              <Field label="Class">
                <select
                  className="select"
                  value={editing.classId}
                  onChange={(e) => setEditing({ ...editing, classId: e.target.value })}
                >
                  <option value="">Unassigned</option>
                  {classes?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Date of birth">
                <input
                  className="input"
                  type="date"
                  value={editing.dateOfBirth}
                  onChange={(e) => setEditing({ ...editing, dateOfBirth: e.target.value })}
                />
              </Field>
              <Field label="Gender">
                <select
                  className="select"
                  value={editing.gender}
                  onChange={(e) => setEditing({ ...editing, gender: e.target.value })}
                >
                  <option value="">Not recorded</option>
                  <option value="female">Female</option>
                  <option value="male">Male</option>
                  <option value="other">Other</option>
                </select>
              </Field>
              <Field label="Guardian name">
                <input
                  className="input"
                  value={editing.guardianName}
                  onChange={(e) => setEditing({ ...editing, guardianName: e.target.value })}
                />
              </Field>
              <Field label="Guardian phone" hint="Used for absence follow-up">
                <input
                  className="input"
                  value={editing.guardianPhone}
                  onChange={(e) => setEditing({ ...editing, guardianPhone: e.target.value })}
                />
              </Field>
              <Field label="Guardian email">
                <input
                  className="input"
                  type="email"
                  value={editing.guardianEmail}
                  onChange={(e) => setEditing({ ...editing, guardianEmail: e.target.value })}
                />
              </Field>
              <Field label="Address" full>
                <input
                  className="input"
                  value={editing.address}
                  onChange={(e) => setEditing({ ...editing, address: e.target.value })}
                />
              </Field>
              <Field label="Notes" full>
                <textarea
                  className="textarea"
                  value={editing.notes}
                  onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                />
              </Field>
            </div>
          </form>
        </Modal>
      )}

      {importing && <ImportModal classes={classes} onClose={() => setImporting(false)} />}
    </div>
  );
}

/**
 * CSV import. Parsing happens in the browser and each row is sent as JSON, so
 * the office can paste a spreadsheet export straight in and see, row by row,
 * exactly which entries were rejected and why.
 */
function ImportModal({ onClose }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);

  const mutation = useMutation({
    mutationFn: (students) => api.post('/api/students/import', { students }),
    onSuccess: (res) => {
      setResult(res);
      toast.success(`Imported ${res.created.length} of ${res.total} rows`);
      queryClient.invalidateQueries({ queryKey: ['students'] });
    },
    onError: (err) => toast.error(err),
  });

  const parse = () => {
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) {
      toast.error('Paste a header row plus at least one student row');
      return;
    }
    const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const columnMap = {
      admissionnumber: 'admissionNumber',
      admission_number: 'admissionNumber',
      'admission no': 'admissionNumber',
      firstname: 'firstName',
      first_name: 'firstName',
      middlename: 'middleName',
      middle_name: 'middleName',
      lastname: 'lastName',
      last_name: 'lastName',
      pin: 'deviceUserPin',
      deviceuserpin: 'deviceUserPin',
      class: 'className',
      classname: 'className',
      guardian: 'guardianName',
      guardianname: 'guardianName',
      guardianphone: 'guardianPhone',
      phone: 'guardianPhone',
      gender: 'gender',
    };

    const students = lines.slice(1).map((line) => {
      const cells = line.split(',').map((c) => c.trim());
      const row = {};
      header.forEach((column, index) => {
        const key = columnMap[column];
        if (key && cells[index]) row[key] = cells[index];
      });
      return row;
    });

    mutation.mutate(students);
  };

  return (
    <Modal
      title="Import students from CSV"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn btn--primary" onClick={parse} disabled={mutation.isPending || !text.trim()}>
            {mutation.isPending ? <Spinner /> : 'Import'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Alert tone="info">
          Paste the CSV including its header row. Recognised columns:{' '}
          <span className="mono">admissionNumber, firstName, middleName, lastName, pin, class, guardianName, phone, gender</span>.
          Rows that fail are listed below; the rest are still imported.
        </Alert>
        <Field label="CSV content">
          <textarea
            className="textarea"
            style={{ minHeight: 180, fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'admissionNumber,firstName,lastName,pin,class\nADM001,Asha,Mushi,1001,Form 1A'}
          />
        </Field>

        {result && (
          <>
            <Alert tone={result.failed.length ? 'warning' : 'success'}>
              {result.created.length} imported, {result.failed.length} rejected.
            </Alert>
            {result.failed.length > 0 && (
              <div className="table-wrap" style={{ maxHeight: 220, overflowY: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Admission no.</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.failed.map((row) => (
                      <tr key={row.row}>
                        <td className="nums">{row.row}</td>
                        <td className="mono">{row.admissionNumber ?? '—'}</td>
                        <td>{row.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
