import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import AppLayout from './components/AppLayout.jsx';
import { Loading } from './components/ui.jsx';

import LoginPage from './pages/LoginPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import AttendancePage from './pages/AttendancePage.jsx';
import StudentsPage from './pages/StudentsPage.jsx';
import StudentDetailPage from './pages/StudentDetailPage.jsx';
import ClassesPage from './pages/ClassesPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';
import AlertsPage from './pages/AlertsPage.jsx';
import DevicesPage from './pages/DevicesPage.jsx';
import CalendarPage from './pages/CalendarPage.jsx';
import UsersPage from './pages/UsersPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import AuditPage from './pages/AuditPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';

/**
 * Route guard. Screens listed under a permission are unreachable by URL as well
 * as invisible in the navigation — the API enforces the same rule, but a
 * teacher typing /users should get a clear redirect, not a wall of 403s.
 */
function RequirePermission({ permission, children }) {
  const { permissions } = useAuth();
  if (permission && !permissions[permission]) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const { isAuthenticated, initializing } = useAuth();

  if (initializing) return <Loading label="Restoring your session…" />;

  if (!isAuthenticated) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<AppLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="attendance" element={<AttendancePage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="students" element={<StudentsPage />} />
        <Route path="students/:id" element={<StudentDetailPage />} />
        <Route path="classes" element={<ClassesPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route
          path="devices"
          element={
            <RequirePermission permission="canViewDevices">
              <DevicesPage />
            </RequirePermission>
          }
        />
        <Route
          path="calendar"
          element={
            <RequirePermission permission="canManageCalendar">
              <CalendarPage />
            </RequirePermission>
          }
        />
        <Route
          path="users"
          element={
            <RequirePermission permission="canManageUsers">
              <UsersPage />
            </RequirePermission>
          }
        />
        <Route
          path="settings"
          element={
            <RequirePermission permission="canManageSettings">
              <SettingsPage />
            </RequirePermission>
          }
        />
        <Route
          path="audit"
          element={
            <RequirePermission permission="canViewAudit">
              <AuditPage />
            </RequirePermission>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
