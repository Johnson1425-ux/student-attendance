import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { initials } from '../utils/format.js';
import ChangePasswordModal from './ChangePasswordModal.jsx';

/**
 * Application shell: sidebar navigation, header, and the routed page body.
 *
 * Navigation is filtered by role rather than merely disabled, so a teacher
 * never sees a link to a screen the API would refuse them.
 */

const NAV_SECTIONS = [
  {
    label: 'Daily',
    items: [
      { to: '/', label: 'Dashboard', icon: '▦', end: true },
      { to: '/attendance', label: 'Attendance', icon: '✓' },
      { to: '/alerts', label: 'Absentee alerts', icon: '!', badge: 'alerts' },
    ],
  },
  {
    label: 'Records',
    items: [
      { to: '/students', label: 'Students', icon: '☰' },
      { to: '/classes', label: 'Classes', icon: '⊞' },
      { to: '/reports', label: 'Reports', icon: '↧' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { to: '/devices', label: 'Terminals', icon: '⌸', permission: 'canViewDevices' },
      { to: '/calendar', label: 'School calendar', icon: '▤', permission: 'canManageCalendar' },
      { to: '/users', label: 'Staff accounts', icon: '⚇', permission: 'canManageUsers' },
      { to: '/settings', label: 'Settings', icon: '⚙', permission: 'canManageSettings' },
      { to: '/audit', label: 'Activity log', icon: '≡', permission: 'canViewAudit' },
    ],
  },
];

const PAGE_TITLES = {
  '/': 'Dashboard',
  '/attendance': 'Attendance register',
  '/alerts': 'Absentee alerts',
  '/students': 'Students',
  '/classes': 'Classes',
  '/reports': 'Reports',
  '/devices': 'Fingerprint terminals',
  '/calendar': 'School calendar',
  '/users': 'Staff accounts',
  '/settings': 'Settings',
  '/audit': 'Activity log',
};

function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('attendance.theme') ?? 'system');

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    localStorage.setItem('attendance.theme', theme);
  }, [theme]);

  return [theme, setTheme];
}

export default function AppLayout() {
  const { user, signOut, permissions } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const [changingPassword, setChangingPassword] = useState(false);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get('/api/settings'),
    staleTime: 5 * 60 * 1000,
  });

  const { data: alertCount } = useQuery({
    queryKey: ['alerts', 'count'],
    queryFn: () => api.get('/api/alerts/count'),
    refetchInterval: 120_000,
  });

  const badges = { alerts: alertCount?.open ?? 0 };
  const title = PAGE_TITLES[location.pathname] ?? 'Attendance';

  return (
    <div className="app-shell">
      {menuOpen && <div className="sidebar-scrim" onClick={() => setMenuOpen(false)} />}

      <aside className={`sidebar ${menuOpen ? 'is-open' : ''}`}>
        <div className="sidebar__brand">
          <div className="sidebar__brand-mark">
            <span className="sidebar__brand-icon" aria-hidden="true">
              ⌾
            </span>
            <span>Attendance</span>
          </div>
          <p className="sidebar__school" title={settings?.school_name}>
            {settings?.school_name ?? 'Loading…'}
          </p>
        </div>

        <nav className="sidebar__nav">
          {NAV_SECTIONS.map((section) => {
            const items = section.items.filter((item) => !item.permission || permissions[item.permission]);
            if (items.length === 0) return null;
            return (
              <div key={section.label}>
                <p className="sidebar__section">{section.label}</p>
                {items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) => `nav-link ${isActive ? 'is-active' : ''}`}
                  >
                    <span aria-hidden="true" style={{ width: 16, textAlign: 'center' }}>
                      {item.icon}
                    </span>
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.badge && badges[item.badge] > 0 && (
                      <span className="nav-link__badge">{badges[item.badge]}</span>
                    )}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>

        <div className="sidebar__footer">
          <div className="user-chip">
            <span className="user-chip__avatar" aria-hidden="true">
              {initials(user?.full_name)}
            </span>
            <div className="flex-1" style={{ minWidth: 0 }}>
              <p className="user-chip__name" title={user?.email}>
                {user?.full_name}
              </p>
              <p className="user-chip__role">{user?.role?.replace('_', ' ')}</p>
            </div>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--block btn--sm"
            style={{ marginTop: 8 }}
            onClick={() => setChangingPassword(true)}
          >
            Change password
          </button>
          <button type="button" className="btn btn--ghost btn--block btn--sm" style={{ marginTop: 4 }} onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="btn btn--ghost btn--sm menu-toggle"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Toggle navigation"
          >
            ☰
          </button>
          <div>
            <h1 className="topbar__title">{title}</h1>
            {settings?.timezone && <p className="topbar__subtitle">All times shown in {settings.timezone}</p>}
          </div>
          <div className="topbar__actions">
            <select
              className="select"
              style={{ width: 'auto' }}
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              aria-label="Colour theme"
            >
              <option value="system">Theme: system</option>
              <option value="light">Theme: light</option>
              <option value="dark">Theme: dark</option>
            </select>
          </div>
        </header>

        <main className="page">
          <Outlet context={{ settings }} />
        </main>
      </div>

      {/* A flagged account is blocked until it sets its own password. This
          overlay sits above every route, so there is no way round it. */}
      {user?.must_change_password ? (
        <ChangePasswordModal forced />
      ) : (
        changingPassword && <ChangePasswordModal onClose={() => setChangingPassword(false)} />
      )}
    </div>
  );
}
