import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useAuth } from '../../contexts/AuthContext';
import { motion, AnimatePresence } from 'motion/react';

import {
  Circle,
  ArrowRight,
  UserPlus,
  LogIn,
  ShieldCheck,
  Zap,
  Eye,
  EyeOff,
} from 'lucide-react';

export const AuthForm = () => {
  const {
    login,
    register,
    forgotPassword,
  } = useAuth();

  const [isLogin, setIsLogin] =
    useState(true);

  const [username, setUsername] =
    useState('');

  const [email, setEmail] =
    useState('');

  const [password, setPassword] =
    useState('');

  const [showPassword, setShowPassword] =
    useState(false);

  const [error, setError] =
    useState('');

  const [loading, setLoading] =
    useState(false);

  const [dbStatus, setDbStatus] =
    useState<
      'checking' | 'connected' | 'error'
    >('checking');

  // =========================
  // DATABASE HEALTH CHECK
  // =========================

  useEffect(() => {
    const checkDb = async () => {
      try {
        const res = await axios.get(
          '/api/health'
        );

        if (
          res.data.database ===
          'connected'
        ) {
          setDbStatus('connected');
          setError('');
        } else if (
          res.data.database ===
          'missing_config'
        ) {
          setDbStatus('error');

          setError(
            'Database configuration (DATABASE_URL) is missing.'
          );
        } else {
          setDbStatus('error');

          setError(
            `Database connection failed: ${res.data.details ||
            'Check your credentials.'
            }`
          );
        }
      } catch {
        setDbStatus('error');

        setError(
          'Server health check failed.'
        );
      }
    };

    checkDb();

    const interval = setInterval(
      checkDb,
      10000
    );

    return () =>
      clearInterval(interval);
  }, []);

  // =========================
  // AUTH
  // =========================

  const handleAuth = async (
    e: React.FormEvent
  ) => {
    e.preventDefault();

    if (
      dbStatus !== 'connected'
    ) {
      setError(
        'Database is not connected.'
      );

      return;
    }

    setError('');
    setLoading(true);

    try {
      if (isLogin) {
        await login(
          email,
          password
        );
      } else {
        await register(
          username,
          email,
          password
        );
      }
    } catch (err: any) {
      setError(
        err.response?.data?.error ||
        'Authentication failed.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!email.trim()) {
      setError('Please enter your email address first.');
      return;
    }

    try {
      setLoading(true);
      setError('');

      await forgotPassword(email);

      alert(
        'Password reset link has been sent to your email.'
      );
    } catch (err: any) {
      setError(
        err.response?.data?.error ||
        'Failed to send reset email.'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen overflow-y-auto overflow-x-hidden bg-white selection:bg-slack-purple/10">

      {/* BACKGROUND */}

      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">

        <motion.div
          animate={{
            x: [0, 50, 0],
            y: [0, 30, 0],
          }}
          transition={{
            duration: 20,
            repeat: Infinity,
            ease: 'linear',
          }}
          className="absolute -top-48 -left-48 w-[600px] h-[600px] bg-slack-purple/5 rounded-full blur-[120px]"
        />

        <motion.div
          animate={{
            x: [0, -50, 0],
            y: [0, -30, 0],
          }}
          transition={{
            duration: 25,
            repeat: Infinity,
            ease: 'linear',
          }}
          className="absolute -bottom-48 -right-48 w-[500px] h-[500px] bg-slack-active/5 rounded-full blur-[120px]"
        />

      </div>

      {/* MAIN */}

      <div className="relative z-10 w-full min-h-full flex flex-col items-center pb-16">

        {/* LOGO */}

        <motion.div
          initial={{
            opacity: 0,
            y: -20,
          }}
          animate={{
            opacity: 1,
            y: 0,
          }}
          className="w-full flex justify-center py-8 md:py-12"
        >

          <div className="flex items-center gap-3">

            <div className="w-10 h-10 md:w-12 md:h-12 bg-slack-purple rounded-xl flex items-center justify-center text-white font-black text-xl md:text-2xl shadow-xl">
              S
            </div>

            <h1 className="text-2xl md:text-3xl font-black text-gray-900 tracking-tight">
              Slick
            </h1>

          </div>

        </motion.div>

        {/* CONTENT */}

        <div className="w-full max-w-6xl flex flex-col md:flex-row items-center md:items-start justify-center gap-10 md:gap-20 lg:gap-28 px-6 pb-32">

          {/* LEFT SIDE */}

          <motion.div
            initial={{
              opacity: 0,
              x: -30,
            }}
            animate={{
              opacity: 1,
              x: 0,
            }}
            className="flex flex-col max-w-md w-full text-center md:text-left"
          >

            <h2 className="text-3xl md:text-5xl font-black text-gray-900 mb-6 leading-tight tracking-tight">

              {isLogin
                ? 'Welcome back to the workspace.'
                : 'Where the future of work happens.'}

            </h2>

            <p className="text-base md:text-lg text-gray-500 font-medium mb-10 leading-relaxed">

              Ditch the noise. Connect with your team in a beautifully designed space that facilitates focus and creativity.

            </p>

            <div className="hidden md:flex flex-col gap-6">

              <div className="flex items-start gap-4">

                <div className="p-3 bg-emerald-50 rounded-xl text-emerald-600 shrink-0">
                  <ShieldCheck size={24} />
                </div>

                <div>

                  <h4 className="font-bold text-gray-900">
                    Secure Database
                  </h4>

                  <p className="text-sm text-gray-500 font-medium">
                    Encryption at rest and in transit.
                  </p>

                </div>

              </div>

              <div className="flex items-start gap-4">

                <div className="p-3 bg-blue-50 rounded-xl text-blue-600 shrink-0">
                  <Zap size={24} />
                </div>

                <div>

                  <h4 className="font-bold text-gray-900">
                    Instant Sync
                  </h4>

                  <p className="text-sm text-gray-500 font-medium">
                    Built on ultra-fast WebSocket cores.
                  </p>

                </div>

              </div>

            </div>

          </motion.div>

          {/* FORM */}

          <motion.div
            initial={{
              opacity: 0,
              y: 30,
            }}
            animate={{
              opacity: 1,
              y: 0,
            }}
            className="w-full max-w-md"
          >

            <div className="bg-white p-6 md:p-10 rounded-[2.5rem] border border-gray-100 shadow-[0_32px_64px_-16px_rgba(0,0,0,0.08)] flex flex-col mb-10">

              {/* TOGGLE */}

              <div className="flex bg-gray-50 p-1.5 rounded-2xl mb-8">

                <button
                  onClick={() =>
                    setIsLogin(true)
                  }
                  className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-black text-sm transition-all ${isLogin
                    ? 'bg-white shadow-md text-gray-900'
                    : 'text-gray-400 hover:text-gray-600'
                    }`}
                >
                  <LogIn size={16} />
                  Login
                </button>

                <button
                  onClick={() =>
                    setIsLogin(false)
                  }
                  className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-black text-sm transition-all ${!isLogin
                    ? 'bg-white shadow-md text-gray-900'
                    : 'text-gray-400 hover:text-gray-600'
                    }`}
                >
                  <UserPlus size={16} />
                  Sign Up
                </button>

              </div>

              {/* FORM BODY */}

              <AnimatePresence mode="wait">

                <motion.div
                  key={
                    isLogin
                      ? 'login'
                      : 'register'
                  }
                  initial={{
                    opacity: 0,
                    y: 10,
                  }}
                  animate={{
                    opacity: 1,
                    y: 0,
                  }}
                  exit={{
                    opacity: 0,
                    y: -10,
                  }}
                  transition={{
                    duration: 0.2,
                  }}
                >

                  <h3 className="text-2xl font-black text-gray-900 mb-2 tracking-tight">

                    {isLogin
                      ? 'Sign In'
                      : 'Create Account'}

                  </h3>

                  <p className="text-gray-400 text-sm font-medium mb-8">

                    {isLogin
                      ? 'Enter your details to continue.'
                      : 'Start your journey with Slick today.'}

                  </p>

                  {/* ERROR */}

                  {error && (
                    <motion.div
                      initial={{
                        scale: 0.95,
                        opacity: 0,
                      }}
                      animate={{
                        scale: 1,
                        opacity: 1,
                      }}
                      className="bg-rose-50 text-rose-600 p-4 rounded-2xl mb-6 text-sm border border-rose-100 flex items-start gap-3"
                    >

                      <Circle
                        size={10}
                        className="mt-1"
                        fill="currentColor"
                        stroke="none"
                      />

                      <span className="font-bold">
                        {error}
                      </span>

                    </motion.div>
                  )}

                  {/* FORM */}

                  <form
                    onSubmit={
                      handleAuth
                    }
                    className="space-y-4"
                  >

                    {!isLogin && (
                      <div className="space-y-1">

                        <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 ml-1">
                          Full Name
                        </label>

                        <input
                          type="text"
                          required
                          value={username}
                          onChange={(e) =>
                            setUsername(
                              e.target
                                .value
                            )
                          }
                          placeholder="What should we call you?"
                          className="w-full p-4 bg-gray-50 border-2 border-transparent rounded-2xl outline-none focus:bg-white focus:border-slack-active text-gray-800 font-bold placeholder:text-gray-300 transition-all"
                        />

                      </div>
                    )}

                    <div className="space-y-1">

                      <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 ml-1">
                        Email Address
                      </label>

                      <input
                        type="email"
                        required
                        value={email}
                        onChange={(e) =>
                          setEmail(
                            e.target
                              .value
                          )
                        }
                        placeholder="name@company.com"
                        className="w-full p-4 bg-gray-50 border-2 border-transparent rounded-2xl outline-none focus:bg-white focus:border-slack-active text-gray-800 font-bold placeholder:text-gray-300 transition-all"
                      />

                    </div>

                    <div className="space-y-1">

                      <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 ml-1">
                        Secret Password
                      </label>

                      <div className="relative">
                        <input
                          type={
                            showPassword
                              ? 'text'
                              : 'password'
                          }
                          required
                          value={password}
                          onChange={(e) =>
                            setPassword(
                              e.target.value
                            )
                          }
                          placeholder="••••••••"
                          className="w-full p-4 pr-14 bg-gray-50 border-2 border-transparent rounded-2xl outline-none focus:bg-white focus:border-slack-active text-gray-800 font-bold placeholder:text-gray-300 transition-all"
                        />

                        <button
                          type="button"
                          onClick={() =>
                            setShowPassword(
                              !showPassword
                            )
                          }
                          className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700"
                        >
                          {showPassword ? (
                            <EyeOff size={20} />
                          ) : (
                            <Eye size={20} />
                          )}
                        </button>
                      </div>

                      {isLogin && (
                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={handleForgotPassword}
                            disabled={loading}
                            className="text-sm font-semibold text-slack-purple hover:underline disabled:opacity-50"
                          >
                            Forgot Password?
                          </button>
                        </div>
                      )}

                    </div>

                    {/* BUTTON */}

                    <button
                      type="submit"
                      disabled={
                        loading ||
                        dbStatus !==
                        'connected'
                      }
                      className="w-full bg-slack-purple text-white font-black py-5 rounded-2xl hover:bg-slack-purple-hover disabled:opacity-50 transition-all active:scale-[0.98] shadow-xl shadow-purple-900/20 flex items-center justify-center gap-2 mt-6 overflow-hidden relative group"
                    >

                      <span className="relative z-10">

                        {loading
                          ? 'Processing...'
                          : isLogin
                            ? 'Sign In'
                            : 'Create Account'}

                      </span>

                      {!loading && (
                        <ArrowRight
                          size={18}
                          className="relative z-10 group-hover:translate-x-1 transition-transform"
                        />
                      )}

                      <motion.div className="absolute inset-0 bg-white/10 translate-y-full group-hover:translate-y-0 transition-transform" />

                    </button>

                  </form>

                  {/* FOOTER */}

                  <div className="mt-8 pt-8 border-t border-gray-50">

                    <p className="text-gray-400 font-bold text-[10px] uppercase tracking-widest text-center">

                      Protected by JWT Architecture

                    </p>

                  </div>

                </motion.div>

              </AnimatePresence>

            </div>

            {/* DATABASE STATUS */}

            <div className="mt-6 flex items-center justify-center gap-3 pb-10">

              <div
                className={`w-2 h-2 rounded-full ${dbStatus ===
                  'connected'
                  ? 'bg-emerald-500'
                  : 'bg-rose-500 animate-pulse'
                  }`}
              />

              <span className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-400">

                System:{' '}
                {dbStatus ===
                  'connected'
                  ? 'Database Operational'
                  : 'Connection Error'}

              </span>

            </div>

          </motion.div>

        </div>

      </div>

    </div>
  );
};