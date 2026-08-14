import { createContext, useContext, useState, useCallback } from 'react';
import { nhost } from './Nhost';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // getUserSession() is synchronous and reads from local storage —
  // no network call, no loading state needed on mount.
  const [session, setSession] = useState(() => nhost.getUserSession());

  // The current SDK has no onAuthStateChanged listener, so we re-read the
  // session ourselves right after any action that could have changed it
  // (sign in, sign up, sign out). SignIn.jsx and the sign-out button both
  // call this.
  const refresh = useCallback(() => {
    setSession(nhost.getUserSession());
  }, []);

  async function signOut() {
    await nhost.auth.signOut({});
    nhost.clearSession();
    refresh();
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