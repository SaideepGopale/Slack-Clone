import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { User } from '../types';

interface AuthContextType {
  user: User | null;
  token: string | null;

  login: (
    email: string,
    password: string
  ) => Promise<void>;

  // Direct, single-step signup — active path right now (no email/OTP
  // round-trip). Creates the account and hydrates the session immediately.
  signup: (
    username: string,
    email: string,
    password: string
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

  logout: () => void;
  loading: boolean;
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
      const t =
        localStorage.getItem('token');

      const validToken =
        t === 'null' ||
        t === 'undefined'
          ? null
          : t;

      if (validToken) {
        axios.defaults.headers.common[
          'Authorization'
        ] = `Bearer ${validToken}`;
      }

      return validToken;
    });

  const [loading, setLoading] =
    useState(true);

  // Allows logout inside effects
  const logoutRef = useRef<
    () => void
  >(() => {});

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');

    delete axios.defaults.headers
      .common['Authorization'];

    setToken(null);
    setUser(null);
  }, []);

  logoutRef.current = logout;

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
    const checkAuth = async () => {
      if (token) {
        try {
          const res =
            await axios.get<User>(
              '/api/auth/me'
            );

          setUser(res.data);

          localStorage.setItem(
            'user',
            JSON.stringify(res.data)
          );
        } catch {
          logoutRef.current();
        }
      } else {
        setUser(null);
      }

      setLoading(false);
    };

    checkAuth();
  }, [token]);

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

    localStorage.setItem(
      'token',
      newToken
    );

    localStorage.setItem(
      'user',
      JSON.stringify(newUser)
    );

    axios.defaults.headers.common[
      'Authorization'
    ] = `Bearer ${newToken}`;

    setToken(newToken);
    setUser(newUser);
  };

  const signup = async (
    username: string,
    email: string,
    password: string
  ) => {
    const res = await axios.post<{
      token: string;
      user: User;
    }>('/api/auth/signup', {
      username,
      email,
      password,
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
    localStorage.setItem('token', newToken);
    localStorage.setItem('user', JSON.stringify(newUser));

    axios.defaults.headers.common[
      'Authorization'
    ] = `Bearer ${newToken}`;

    setToken(newToken);
    setUser(newUser);
  };

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