import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { applyTabSessionUrl, clearStoredToken, readStoredToken, writeStoredToken } from '../lib/devTabSession';
import { User } from '../types';

interface AuthContextType {
  user: User | null;
  token: string | null;

  /** P2: keeps the in-session copy of User.lastActiveWorkspaceId current ("/" lands there). */
  setLastActiveWorkspace?: (workspaceId: string) => void;

  login: (
    email: string,
    password: string
  ) => Promise<void>;

  // Direct, single-step signup — active path right now (no email/OTP
  // round-trip). Creates the account and hydrates the session immediately.
  // T.21: sign-up is invitation-only — inviteToken is the e-mail invitation
  // (verified by the server) that this address was invited with.
  signup: (
    username: string,
    email: string,
    password: string,
    inviteToken?: string
  ) => Promise<void>;

  // Step 1 of sign-up: requests an email OTP. No session exists yet — the
  // account isn't created until verifySignupOtp succeeds.
  requestSignupOtp: (
    username: string,
    email: string,
    password: string
  ) => Promise<{ expiresAt: string }>;

  // Step 2: submits the code, and on success the backend has already
  // created the account and issued a token — hydrates that into session
  // state the same way hydrateSession does.
  verifySignupOtp: (
    email: string,
    code: string
  ) => Promise<void>;

  forgotPassword: (
    email: string
  ) => Promise<void>;

  // Hydrates an already-issued {token, user} pair into session state without
  // making a login/register call — used internally by verifySignupOtp once
  // the backend has already created the account and signed a token.
  hydrateSession: (
    token: string,
    user: User
  ) => void;

  /** Signs out: ends the server-side session (T.32), then clears this tab. */
  logout: () => void;
  loading: boolean;
  /**
   * T.32 (audit M17): set when the session could not be checked for a reason
   * other than "the session is over" (network error, server 5xx, rate limit).
   * The token is kept — the user is not signed out by a transient failure.
   */
  sessionError: string | null;
  retrySession: () => void;
}

const AuthContext = createContext<
  AuthContextType | undefined
>(undefined);

export const AuthProvider: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  const [user, setUser] =
    useState<User | null>(null);

  const [token, setToken] =
    useState<string | null>(() => {
      // T.37: the shared localStorage token, or — for an isolated local
      // development tab (?tabSession=1) — this tab's own one.
      applyTabSessionUrl();
      const validToken = readStoredToken();

      if (validToken) {
        axios.defaults.headers.common[
          'Authorization'
        ] = `Bearer ${validToken}`;
      }

      return validToken;
    });

  const [loading, setLoading] =
    useState(true);

  const [sessionError, setSessionError] =
    useState<string | null>(null);
  const [sessionAttempt, setSessionAttempt] =
    useState(0);

  // Allows logout inside effects
  const logoutRef = useRef<
    () => void
  >(() => {});

  // Local sign-out only: the server already considers the session over
  // (a 401), or logout() below has asked it to end the session.
  const clearSession = useCallback(() => {
    clearStoredToken();
    // Older builds kept a copy of the user object here; nothing reads it.
    localStorage.removeItem('user');

    delete axios.defaults.headers
      .common['Authorization'];

    setSessionError(null);
    setToken(null);
    setUser(null);
  }, []);

  // T.32 (audit H1): logging out ends the server-side session, so the token
  // stops working everywhere it may have been copied. Local sign-out never
  // waits for the network.
  const logout = useCallback(() => {
    const current = readStoredToken();
    if (current) {
      void axios
        .post('/api/auth/logout', null, { headers: { Authorization: `Bearer ${current}` } })
        .catch(() => undefined);
    }
    clearSession();
  }, [clearSession]);

  logoutRef.current = clearSession;

  // A stale copy of the user object from older builds (never read).
  useEffect(() => {
    try {
      localStorage.removeItem('user');
    } catch {
      // storage unavailable
    }
  }, []);

  useEffect(() => {
    if (token) {
      axios.defaults.headers.common[
        'Authorization'
      ] = `Bearer ${token}`;
    } else {
      delete axios.defaults.headers
        .common['Authorization'];
    }
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const checkAuth = async () => {
      if (!token) {
        setUser(null);
        setLoading(false);
        return;
      }
      setSessionError(null);
      // T.32 (audit M17): only a 401 means the session is over. Anything else
      // (offline, a cold-starting server, 5xx, 429) is retried briefly and
      // then shown as a recoverable error — never a silent sign-out.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await axios.get<User>('/api/auth/me');
          if (cancelled) return;
          setUser(res.data);
          setLoading(false);
          return;
        } catch (err) {
          if (cancelled) return;
          if (axios.isAxiosError(err) && err.response?.status === 401) {
            logoutRef.current();
            setLoading(false);
            return;
          }
          if (attempt < 2) await wait(800 * 2 ** attempt);
        }
      }
      if (cancelled) return;
      setSessionError('We could not reach SmartConnect. Check your connection and try again.');
      setLoading(false);
    };

    checkAuth();
    return () => {
      cancelled = true;
    };
  }, [token, sessionAttempt]);

  const retrySession = useCallback(() => {
    setLoading(true);
    setSessionAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    const interceptor =
      axios.interceptors.response.use(
        (response) => response,
        (error) => {
          if (
            error.response?.status ===
            401
          ) {
            logoutRef.current();
          }

          return Promise.reject(error);
        }
      );

    return () =>
      axios.interceptors.response.eject(
        interceptor
      );
  }, []);

  const login = async (
    email: string,
    password: string
  ) => {
    const res = await axios.post<{
      token: string;
      user: User;
    }>('/api/auth/login', {
      email,
      password,
    });

    const {
      token: newToken,
      user: newUser,
    } = res.data;

    writeStoredToken(newToken);

    axios.defaults.headers.common[
      'Authorization'
    ] = `Bearer ${newToken}`;

    setToken(newToken);
    setUser(newUser);
  };

  const signup = async (
    username: string,
    email: string,
    password: string,
    inviteToken?: string
  ) => {
    const res = await axios.post<{
      token: string;
      user: User;
    }>('/api/auth/signup', {
      username,
      email,
      password,
      ...(inviteToken ? { inviteToken } : {}),
    });

    hydrateSession(res.data.token, res.data.user);
  };

  const requestSignupOtp = async (
    username: string,
    email: string,
    password: string
  ) => {
    const res = await axios.post<{
      message: string;
      expiresAt: string;
    }>('/api/auth/signup-request', {
      username,
      email,
      password,
    });

    return { expiresAt: res.data.expiresAt };
  };

  const verifySignupOtp = async (
    email: string,
    code: string
  ) => {
    const res = await axios.post<{
      token: string;
      user: User;
    }>('/api/auth/verify-otp', {
      email,
      code,
    });

    hydrateSession(res.data.token, res.data.user);
  };

  const forgotPassword = async (
    email: string
  ) => {
    await axios.post(
      '/api/auth/forgot-password',
      { email }
    );
  };

  const hydrateSession = (
    newToken: string,
    newUser: User
  ) => {
    writeStoredToken(newToken);

    axios.defaults.headers.common[
      'Authorization'
    ] = `Bearer ${newToken}`;

    setToken(newToken);
    setUser(newUser);
  };

  const setLastActiveWorkspace = useCallback((workspaceId: string) => {
    setUser((prev) => {
      if (!prev || prev.lastActiveWorkspaceId === workspaceId) return prev;
      return { ...prev, lastActiveWorkspaceId: workspaceId };
    });
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        login,
        signup,
        requestSignupOtp,
        verifySignupOtp,
        forgotPassword,
        hydrateSession,
        logout,
        loading,
        sessionError,
        retrySession,
        setLastActiveWorkspace,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context =
    useContext(AuthContext);

  if (!context) {
    throw new Error(
      'useAuth must be used within AuthProvider'
    );
  }

  return context;
};