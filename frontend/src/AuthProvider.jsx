import { createContext, useContext, useState, useCallback } from 'react';
import { nhost } from './Nhost';
import { apolloClient } from './Apolloclient';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => nhost.getUserSession());

  const refresh = useCallback(() => {
    setSession(nhost.getUserSession());
  }, []);

  async function signOut() {
    // try/finally is the fix here: if signOut() or clearStore() throws for
    // any reason, refresh() must still run — otherwise isAuthenticated never
    // flips to false and the redirect to SignIn silently never happens.
    try {
      await nhost.auth.signOut({});
    } catch (e) {
      console.error('nhost signOut failed (continuing anyway):', e);
    }
    try {
      nhost.clearSession();
    } catch (e) {
      console.error('clearSession failed (continuing anyway):', e);
    }
    try {
      await apolloClient.clearStore();
    } catch (e) {
      console.error('Apollo clearStore failed (continuing anyway):', e);
    } finally {
      refresh();
    }
  }

  const value = {
    user: session?.user ?? null,
    isAuthenticated: !!session,
    isLoading: false,
    refresh,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}