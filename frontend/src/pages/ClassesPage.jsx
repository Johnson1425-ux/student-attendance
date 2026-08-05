import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { Card, Loading, ErrorState, EmptyState, Modal, Field, Spinner, ConfirmDialog } from '../components/ui.jsx';

const currentYear = String(new Date().getFullYear());

export default function ClassesPage() {
  const { permissions } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [includeInactive, setIncludeInactive] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [roster, setRoster] = useState(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['classes', includeInactive],
    queryFn: () => api.get('/api/classes', { includeInactive: String(includeInactive) }),
  });

  // Only teachers can be assigned to a class, so the picker asks for that role.
  const { data: teachers } = useQuery({
    queryKey: ['users', 'teachers'],
    queryFn: () => api.get('/api/users', { role: 'teacher' }),
    enabled: permissions.canManageUsers,
  });

  const saveMutation = useMutation({
    mutationFn: ({ id, payload }) => (id ? api.patch(`/api/classes/${id}`, payload) : api.post('/api/classes', payload)),
    onSuccess: (_, variables) => {
      toast.success(variables.id ? 'Class updated' : 'Class created');
      setEditing(null);
      queryClient.invalidateQueries({ queryKey: ['classes'] });
    },
    onError: (err) => toast.error(err),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => api.delete(`/api/classes/${id}`),
    onSuccess: () => {
      toast.success('Class removed');
      setDeleting(null);
      queryClient.invalidateQueries({ queryKey: ['classes'] });
    },
    onError: (err) => {
      toast.error(err);
      setDeleting(null);
    },
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;

  return (
    <div className="stack">
      <Card>
        <div className="filter-bar">
          <label className="checkbox">
            <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
            Show inactive classes
          </label>
          {permissions.canManageClasses && (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              style={{ marginLeft: 'auto' }}
              onClick={() =>
                setEditing({ name: '', gradeLevel: '', stream: '', academicYear: currentYear, room: '', teacherIds: [] })
              }
            >
              Add class
            </button>
          )}
        </div>
      </Card>

      <Card flush>
        {data.length === 0 ? (
          <EmptyState title="No classes yet" description="Create a class before enrolling students." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Class</th>
                  <th>Grade</th>
                  <th>Year</th>
                  <th className="table__num">Students</th>
                  <th>Teachers</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((klass) => (
                  <tr key={klass.id}>
                    <td>
                      <span className="table__primary">{klass.name}</span>
                      {klass.room && <div className="table__secondary">Room {klass.room}</div>}
                    </td>
                    <td>{klass.grade_level ?? '—'}</td>
                    <td className="nums">{klass.academic_year}</td>
                    <td className="table__num">{klass.student_count}</td>
                    <td>
                      {klass.teacher_names?.length ? (
                        klass.teacher_names.join(', ')
                      ) : (
                        <span className="subtle">Not assigned</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${klass.is_active ? 'badge--present' : ''}`}>
                        {klass.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>
                      <div className="table__actions">
                        <Link to={`/attendance?classId=${klass.id}`} className="btn btn--sm">
                          Register
                        </Link>
                        <button type="button" className="btn btn--sm" onClick={() => setRoster(klass)}>
                          Roster
                        </button>
                        {permissions.canManageClasses && (
                          <>
                            <button
                              type="button"
                              className="btn btn--sm"
                              onClick={() =>
                                setEditing({
                                  id: klass.id,
                                  name: klass.name,
                                  gradeLevel: klass.grade_level ?? '',
                                  stream: klass.stream ?? '',
                                  academicYear: klass.academic_year,
                                  room: klass.room ?? '',
                                  isActive: klass.is_active,
                                  teacherIds: klass.teacher_ids ?? [],
                                })
                              }
                            >
                              Edit
                            </button>
                            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDeleting(klass)}>
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <Modal
          title={editing.id ? `Edit ${editing.name}` : 'Add a class'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" form="class-form" className="btn btn--primary" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? <Spinner /> : 'Save'}
              </button>
            </>
          }
        >
          <form
            id="class-form"
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              const { id, ...form } = editing;
              saveMutation.mutate({
                id,
                payload: {
                  name: form.name,
                  gradeLevel: form.gradeLevel || null,
                  stream: form.stream || null,
                  academicYear: form.academicYear,
                  room: form.room || null,
                  isActive: form.isActive ?? true,
                  teacherIds: form.teacherIds.map(Number),
                },
              });
            }}
          >
            <Field label="Class name *" hint="e.g. Form 1A">
              <input
                className="input"
                required
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Field>
            <Field label="Academic year *">
              <input
                className="input"
                required
                value={editing.academicYear}
                onChange={(e) => setEditing({ ...editing, academicYear: e.target.value })}
              />
            </Field>
            <Field label="Grade / level">
              <input
                className="input"
                value={editing.gradeLevel}
                onChange={(e) => setEditing({ ...editing, gradeLevel: e.target.value })}
              />
            </Field>
            <Field label="Stream">
              <input
                className="input"
                value={editing.stream}
                onChange={(e) => setEditing({ ...editing, stream: e.target.value })}
              />
            </Field>
            <Field label="Room">
              <input
                className="input"
                value={editing.room}
                onChange={(e) => setEditing({ ...editing, room: e.target.value })}
              />
            </Field>
            {editing.id && (
              <Field label="Status">
                <select
                  className="select"
                  value={editing.isActive ? 'true' : 'false'}
                  onChange={(e) => setEditing({ ...editing, isActive: e.target.value === 'true' })}
                >
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </Field>
            )}
            {permissions.canManageUsers && (
              <Field
                label="Teachers"
                hint="Assigned teachers can see this class's attendance. Hold Ctrl/Cmd to select several."
                full
              >
                <select
                  className="select"
                  multiple
                  size={Math.min(6, Math.max(3, teachers?.length ?? 3))}
                  value={editing.teacherIds.map(String)}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      teacherIds: [...e.target.selectedOptions].map((option) => option.value),
                    })
                  }
                >
                  {teachers?.map((teacher) => (
                    <option key={teacher.id} value={teacher.id}>
                      {teacher.full_name} ({teacher.email})
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </form>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          message={
            deleting.student_count > 0
              ? `${deleting.name} has ${deleting.student_count} student(s). Classes with enrolment history cannot be deleted — mark it inactive instead.`
              : `${deleting.name} will be permanently removed.`
          }
          confirmLabel="Delete"
          tone="danger"
          busy={deleteMutation.isPending}
          onClose={() => setDeleting(null)}
          onConfirm={() => deleteMutation.mutate(deleting.id)}
        />
      )}

      {roster && <RosterModal klass={roster} onClose={() => setRoster(null)} />}
    </div>
  );
}

function RosterModal({ klass, onClose }) {
  const { data, isLoading } = useQuery({
    queryKey: ['roster', klass.id],
    queryFn: () => api.get(`/api/students/class/${klass.id}/roster`),
  });

  return (
    <Modal title={`${klass.name} — roster`} onClose={onClose} size="lg">
      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <EmptyState title="No students enrolled" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Student</th>
                <th>Admission no.</th>
                <th>Terminal PIN</th>
                <th>Fingerprints</th>
              </tr>
            </thead>
            <tbody>
              {data.map((student) => (
                <tr key={student.id}>
                  <td>
                    <Link to={`/students/${student.id}`} className="table__primary">
                      {student.full_name}
                    </Link>
                  </td>
                  <td className="mono">{student.admission_number}</td>
                  <td className="mono">{student.device_user_pin ?? '—'}</td>
                  <td>
                    {student.fingerprints_enrolled > 0 ? (
                      <span className="badge badge--present">{student.fingerprints_enrolled}</span>
                    ) : (
                      <span className="badge badge--absent">None</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
