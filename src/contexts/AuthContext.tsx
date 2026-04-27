import React, { createContext, useContext, useState, useEffect } from 'react';
import axios from 'axios';

interface AuthContextType {
  user: any;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  skipLogin: () => void;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<any>(null);
  const [token, setToken] = useState<string | null>(() => {
    const t = localStorage.getItem('token');
    return (t === 'null' || t === 'undefined') ? null : t;
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (token) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    } else {
      delete axios.defaults.headers.common['Authorization'];
    }
  }, [token]);

  useEffect(() => {
    const checkAuth = async () => {
      if (token && token !== 'guest-token') {
        try {
          const res = await axios.get('/api/auth/me');
          setUser(res.data);
          localStorage.setItem('user', JSON.stringify(res.data));
        } catch (err) {
          console.error('Session verification failed', err);
          logout();
        }
      } else if (token === 'guest-token') {
        const savedUser = localStorage.getItem('user');
        if (savedUser) {
          try {
            setUser(JSON.parse(savedUser));
          } catch {
            logout();
          }
        }
      } else {
        setUser(null);
      }
      setLoading(false);
    };
    checkAuth();
  }, [token]);

  useEffect(() => {
    // Axios interceptor for global auth handling
    const interceptor = axios.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 401) {
          logout();
        }
        return Promise.reject(error);
      }
    );
    return () => axios.interceptors.response.eject(interceptor);
  }, []);

  const login = async (email: string, password: string) => {
    const res = await axios.post('/api/auth/login', { email, password });
    const { token, user } = res.data;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    setToken(token);
    setUser(user);
  };

  const register = async (username: string, email: string, password: string) => {
    const res = await axios.post('/api/auth/register', { username, email, password });
    const { token, user } = res.data;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    setToken(token);
    setUser(user);
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setToken(null);
    setUser(null);
  };

  const skipLogin = () => {
    const guestUser = { id: 'guest', username: 'Guest Explorer', email: 'guest@slick.demo' };
    setUser(guestUser);
    setToken('guest-token'); // Dummy token to bypass checks
    localStorage.setItem('user', JSON.stringify(guestUser));
    localStorage.setItem('token', 'guest-token');
  };

  return (
    <AuthContext.Provider value={{ user, token, login, register, logout, skipLogin, loading }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
