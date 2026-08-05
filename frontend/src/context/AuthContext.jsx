import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, loadSession, saveSession, clearSession, setUnauthenticatedHandler } from '../api/client.js';

const AuthContext = createContext(null);

/** Capability map, mirroring the role rules the API enforces (PRD §4). */
function permissionsFor(role) {
  const isAdmin = role === 'admin';
  const isOffice = role === 'office_staff';
  return {
    isAdmin,
    isOffice,
    isTeacher: role === 'teacher',
    // Staff = admin or office: the two roles that may change records.
    canManageStudents: isAdmin || isOffice,
    canEditAttendance: isAdmin || isOffice,
    canManageClasses: isAdmin,
    canManageUsers: isAdmin,
    canManageDevices: isAdmin,
    canViewDevices: isAdmin || isOffice,
    canManageSettings: isAdmin,
    canViewAudit: isAdmin,
    canManageCalendar: isAdmin,
  };
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => loadSession());
  const [initializing, setInitializing] = useState(Boolean(loadSession()));

  const signOut = useCallback(async () => {
    const current = loadSession();
    if (current?.refreshToken) {
      // Best effort: revoke server-side, but never block sign-out on the network.
      api.post('/api/auth/logout', { refreshToken: current.refreshToken }).catch(() => {});
    }
    clearSession();
    setSession(null);
  }, []);

  useEffect(() => {
    setUnauthenticatedHandler(() => setSession(null));
  }, []);

  // Re-validate a stored session on load: the account may have been
  // deactivated, or its role changed, since the tab was last open.
  useEffect(() => {
    let cancelled = false;
    if (!session?.accessToken) {
      setInitializing(false);
      return undefined;
    }
    (async () => {
      try {
        const user = await api.get('/api/auth/me');
        if (cancelled) return;
        setSession((prev) => {
          const next = { ...prev, user };
          saveSession(next);
          return next;
        });
      } catch {
        if (!cancelled) {
          clearSession();
          setSession(null);
        }
      } finally {
        if (!cancelled) setInitializing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs once on mount; later token changes are handled by the API client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = useCallback(async (email, password) => {
    const result = await api.post('/api/auth/login', { email, password });
    saveSession(result);
    setSession(result);
    return result;
  }, []);

  const value = useMemo(
    () => ({
      user: session?.user ?? null,
      isAuthenticated: Boolean(session?.accessToken),
      initializing,
      signIn,
      signOut,
      permissions: permissionsFor(session?.user?.role),
      refreshUser: async () => {
        const user = await api.get('/api/auth/me');
        setSession((prev) => {
          const next = { ...prev, user };
          saveSession(next);
          return next;
        });
        return user;
      },
    }),
    [session, initializing, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
