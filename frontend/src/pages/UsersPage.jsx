import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { Card, Loading, ErrorState, EmptyState, Modal, Field, Spinner, Alert, ConfirmDialog } from '../components/ui.jsx';
import { formatDateTime } from '../utils/format.js';

const ROLE_LABELS = {
  admin: 'Administrator',
  office_staff: 'Office staff',
  teacher: 'Teacher',
};

const ROLE_DESCRIPTIONS = {
  admin: 'Full access, including staff accounts, terminals and settings.',
  office_staff: 'Manage students, enrolment and attendance corrections.',
  teacher: 'View attendance for their own classes only.',
};

export default function UsersPage() {
  const { user: currentUser } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [credentials, setCredentials] = useState(null);

  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['users'], queryFn: () => api.get('/api/users') });
  const { data: classes } = useQuery({ queryKey: ['classes'], queryFn: () => api.get('/api/classes') });

  const saveMutation = useMutation({
    mutationFn: ({ id, payload }) => (id ? api.patch(`/api/users/${id}`, payload) : api.post('/api/users', payload)),
    onSuccess: (result, variables) => {
      setEditing(null);
      queryClient.invalidateQueries({ queryKey: ['users'] });
      if (result.generatedPassword) {
        setCredentials({ name: result.full_name, email: result.email, password: result.generatedPassword });
      } else {
        toast.success(variables.id ? 'Account updated' : 'Account created');
      }
    },
    onError: (err) => toast.error(err),
  });

  const resetMutation = useMutation({
    mutationFn: (id) => api.post(`/api/users/${id}/reset-password`, {}),
    onSuccess: (result) => {
      setCredentials({ name: result.full_name, email: result.email, password: result.temporaryPassword });
    },
    onError: (err) => toast.error(err),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => api.delete(`/api/users/${id}`),
    onSuccess: () => {
      toast.success('Account deleted');
      setDeleting(null);
      queryClient.invalidateQueries({ queryKey: ['users'] });
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
        <div className="row row--between row--wrap">
          <p className="small muted">
            Staff accounts and what each role may do. Teachers only ever see the classes assigned to them.
          </p>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => setEditing({ email: '', fullName: '', role: 'teacher', phone: '', classIds: [] })}
          >
            Add account
          </button>
        </div>
      </Card>

      <Card flush>
        {data.length === 0 ? (
          <EmptyState title="No accounts" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Classes</th>
                  <th>Last sign-in</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((account) => (
                  <tr key={account.id}>
                    <td>
                      <span className="table__primary">{account.full_name}</span>
                      {account.id === currentUser.id && <span className="badge badge--accent" style={{ marginLeft: 8 }}>You</span>}
                      {account.must_change_password && (
                        <div className="table__secondary">Must change password at next sign-in</div>
                      )}
                    </td>
                    <td className="small">{account.email}</td>
                    <td>
                      <span className="badge badge--accent">{ROLE_LABELS[account.role]}</span>
                    </td>
                    <td className="small">
                      {account.role === 'teacher'
                        ? account.class_names?.length
                          ? account.class_names.join(', ')
                          : <span className="subtle">None assigned</span>
                        : <span className="subtle">All</span>}
                    </td>
                    <td className="small muted no-wrap">
                      {account.last_login_at ? formatDateTime(account.last_login_at) : 'never'}
                    </td>
                    <td>
                      <span className={`badge ${account.is_active ? 'badge--present' : 'badge--absent'}`}>
                        {account.is_active ? 'Active' : 'Disabled'}
                      </span>
                    </td>
                    <td>
                      <div className="table__actions">
                        <button
                          type="button"
                          className="btn btn--sm"
                          onClick={() =>
                            setEditing({
                              id: account.id,
                              email: account.email,
                              fullName: account.full_name,
                              role: account.role,
                              phone: account.phone ?? '',
                              isActive: account.is_active,
                              classIds: account.class_ids ?? [],
                            })
                          }
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm"
                          onClick={() => resetMutation.mutate(account.id)}
                          disabled={resetMutation.isPending}
                        >
                          Reset password
                        </button>
                        {account.id !== currentUser.id && (
                          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDeleting(account)}>
                            Delete
                          </button>
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
          title={editing.id ? `Edit ${editing.fullName}` : 'Add a staff account'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" form="user-form" className="btn btn--primary" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? <Spinner /> : 'Save'}
              </button>
            </>
          }
        >
          <form
            id="user-form"
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              const { id, ...form } = editing;
              const payload = {
                email: form.email,
                fullName: form.fullName,
                role: form.role,
                phone: form.phone || null,
                classIds: form.role === 'teacher' ? form.classIds.map(Number) : [],
              };
              if (id && form.isActive !== undefined) payload.isActive = form.isActive;
              saveMutation.mutate({ id, payload });
            }}
          >
            {!editing.id && (
              <Alert tone="info">
                A temporary password is generated and shown once when the account is created. The user is required to
                change it at first sign-in.
              </Alert>
            )}
            <div className="form-grid">
              <Field label="Full name *">
                <input
                  className="input"
                  required
                  value={editing.fullName}
                  onChange={(e) => setEditing({ ...editing, fullName: e.target.value })}
                />
              </Field>
              <Field label="Email *">
                <input
                  className="input"
                  type="email"
                  required
                  value={editing.email}
                  onChange={(e) => setEditing({ ...editing, email: e.target.value })}
                />
              </Field>
              <Field label="Phone">
                <input
                  className="input"
                  value={editing.phone}
                  onChange={(e) => setEditing({ ...editing, phone: e.target.value })}
                />
              </Field>
              <Field label="Role *" hint={ROLE_DESCRIPTIONS[editing.role]}>
                <select
                  className="select"
                  value={editing.role}
                  disabled={editing.id === currentUser.id}
                  onChange={(e) => setEditing({ ...editing, role: e.target.value })}
                >
                  <option value="teacher">Teacher</option>
                  <option value="office_staff">Office staff</option>
                  <option value="admin">Administrator</option>
                </select>
              </Field>
              {editing.id && editing.id !== currentUser.id && (
                <Field label="Status">
                  <select
                    className="select"
                    value={editing.isActive ? 'true' : 'false'}
                    onChange={(e) => setEditing({ ...editing, isActive: e.target.value === 'true' })}
                  >
                    <option value="true">Active</option>
                    <option value="false">Disabled</option>
                  </select>
                </Field>
              )}
              {editing.role === 'teacher' && (
                <Field label="Assigned classes" hint="Hold Ctrl/Cmd to select several" full>
                  <select
                    className="select"
                    multiple
                    size={Math.min(6, Math.max(3, classes?.length ?? 3))}
                    value={editing.classIds.map(String)}
                    onChange={(e) =>
                      setEditing({ ...editing, classIds: [...e.target.selectedOptions].map((o) => o.value) })
                    }
                  >
                    {classes?.map((klass) => (
                      <option key={klass.id} value={klass.id}>
                        {klass.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
          </form>
        </Modal>
      )}

      {credentials && (
        <Modal
          title="Temporary password"
          onClose={() => setCredentials(null)}
          size="sm"
          footer={
            <button type="button" className="btn btn--primary" onClick={() => setCredentials(null)}>
              I have noted it down
            </button>
          }
        >
          <div className="stack">
            <Alert tone="warning">
              This password is shown once. Give it to {credentials.name} in person — they will be asked to change it when
              they sign in.
            </Alert>
            <Field label="Email">
              <input className="input mono" readOnly value={credentials.email} onFocus={(e) => e.target.select()} />
            </Field>
            <Field label="Temporary password">
              <input className="input mono" readOnly value={credentials.password} onFocus={(e) => e.target.select()} />
            </Field>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.full_name}?`}
          message="The account will be removed permanently. Any attendance corrections they made stay in the activity log."
          confirmLabel="Delete account"
          tone="danger"
          busy={deleteMutation.isPending}
          onClose={() => setDeleting(null)}
          onConfirm={() => deleteMutation.mutate(deleting.id)}
        />
      )}
    </div>
  );
}
