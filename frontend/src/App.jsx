import { lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import AppLayout from './components/AppLayout.jsx';
import { Loading } from './components/ui.jsx';

import LoginPage from './pages/LoginPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';

// Every signed-in screen is its own chunk, fetched the first time it is
// opened. The charts library in particular is only downloaded by the two
// screens that draw charts, not by the login page.
const DashboardPage = lazy(() => import('./pages/DashboardPage.jsx'));
const AttendancePage = lazy(() => import('./pages/AttendancePage.jsx'));
const StudentsPage = lazy(() => import('./pages/StudentsPage.jsx'));
const StudentDetailPage = lazy(() => import('./pages/StudentDetailPage.jsx'));
const ClassesPage = lazy(() => import('./pages/ClassesPage.jsx'));
const ReportsPage = lazy(() => import('./pages/ReportsPage.jsx'));
const AlertsPage = lazy(() => import('./pages/AlertsPage.jsx'));
const DevicesPage = lazy(() => import('./pages/DevicesPage.jsx'));
const CalendarPage = lazy(() => import('./pages/CalendarPage.jsx'));
const UsersPage = lazy(() => import('./pages/UsersPage.jsx'));
const SettingsPage = lazy(() => import('./pages/SettingsPage.jsx'));
const AuditPage = lazy(() => import('./pages/AuditPage.jsx'));

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
