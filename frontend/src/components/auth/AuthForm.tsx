import axios from 'axios';
import { ArrowLeft, ArrowRight, Eye, EyeOff, Loader2, Lock, Mail, RefreshCw, Shield, ShieldCheck, Zap } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { useAuth } from '../../contexts/AuthContext';

const OTP_LENGTH = 6;

interface AuthFormProps {
  // /signup lands here defaulted to the Sign Up tab instead of Login.
  startOnSignup?: boolean;
  // Comes from ?email=... on an invite-driven signup (see LoginPage.tsx) —
  // the invited address is fixed, so the field is locked rather than editable.
  presetEmail?: string;
}

export const AuthForm = ({ startOnSignup = false, presetEmail }: AuthFormProps) => {
  const { login, requestSignupOtp, verifySignupOtp } = useAuth();
  const [isLogin, setIsLogin] = useState(!startOnSignup);
  const [email, setEmail] = useState(presetEmail ?? '');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string, type: 'error' | 'success' } | null>(null);

  // Admin Portal State
  const [isAdminMode, setIsAdminMode] = useState(false);

  // Sign-up is a two-step flow: collect details -> verify the emailed code.
  // No account exists (and no session starts) until step 2 succeeds.
  const [signupStep, setSignupStep] = useState<'form' | 'otp'>('form');
  const [otpDigits, setOtpDigits] = useState<string[]>(Array(OTP_LENGTH).fill(''));
  const [otpExpiresAt, setOtpExpiresAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const otpInputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (!otpExpiresAt) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((otpExpiresAt - Date.now()) / 1000)));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [otpExpiresAt]);

  const resetSignupFlow = () => {
    setSignupStep('form');
    setOtpDigits(Array(OTP_LENGTH).fill(''));
    setOtpExpiresAt(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);
    try {
      if (isAdminMode || isLogin) {
        await login(email, password);
        return;
      }

      const { expiresAt } = await requestSignupOtp(username, email, password);
      setOtpExpiresAt(new Date(expiresAt).getTime());
      setSignupStep('otp');
      toast.success(`Verification code sent to ${email}`);
    } catch (err: any) {
      const text = err.response?.data?.error || 'Authentication failed';
      setMessage({ text, type: 'error' });
      toast.error(text);
    } finally {
      setLoading(false);
    }
  };

  const handleOtpDigitChange = (index: number, value: string) => {
    const digit = value.replace(/\D/g, '').slice(-1);
    setOtpDigits((prev) => {
      const next = [...prev];
      next[index] = digit;
      return next;
    });
    if (digit && index < OTP_LENGTH - 1) {
      otpInputRefs.current[index + 1]?.focus();
    }
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otpDigits[index] && index > 0) {
      otpInputRefs.current[index - 1]?.focus();
    }
  };

  const handleOtpPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH);
    if (!pasted) return;
    e.preventDefault();
    setOtpDigits((prev) => {
      const next = [...prev];
      for (let i = 0; i < OTP_LENGTH; i++) next[i] = pasted[i] ?? next[i];
      return next;
    });
    otpInputRefs.current[Math.min(pasted.length, OTP_LENGTH - 1)]?.focus();
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = otpDigits.join('');
    if (code.length !== OTP_LENGTH) {
      toast.error(`Enter all ${OTP_LENGTH} digits.`);
      return;
    }

    setVerifying(true);
    try {
      await verifySignupOtp(email, code);
      toast.success('Email verified — welcome aboard!');
      // AuthContext now has a user/token; the router redirects away from
      // here on its own (see pages/auth/LoginPage.tsx), no navigation needed.
    } catch (err: any) {
      const text = err.response?.data?.error || 'Invalid or expired code.';
      toast.error(text);
    } finally {
      setVerifying(false);
    }
  };

  const handleResendCode = async () => {
    if (secondsLeft > 0) return;
    setResending(true);
    try {
      const { expiresAt } = await requestSignupOtp(username, email, password);
      setOtpExpiresAt(new Date(expiresAt).getTime());
      setOtpDigits(Array(OTP_LENGTH).fill(''));
      otpInputRefs.current[0]?.focus();
      toast.success('New code sent.');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to resend code.');
    } finally {
      setResending(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!email) {
      setMessage({ text: 'Please enter your email address first.', type: 'error' });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const res = await axios.post('/api/auth/forgot-password', { email });
      setMessage({ text: res.data.message || 'Reset link sent to your email!', type: 'success' });
    } catch (err: any) {
      setMessage({ text: err.response?.data?.error || 'Failed to send reset email.', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const toggleAdminMode = () => {
    setIsAdminMode(!isAdminMode);
    setIsLogin(true);
    setMessage(null);
    setEmail('');
    setPassword('');
    resetSignupFlow();
  };

  // ==========================================
  // 🏢 PROFESSIONAL ADMIN UI (ENTERPRISE GRADE)
  // ==========================================
  if (isAdminMode) {
    return (
      <div className="min-h-screen bg-[#0B101E] flex flex-col justify-center py-12 sm:px-6 lg:px-8 font-sans selection:bg-indigo-500/30">
        
        <div className="sm:mx-auto sm:w-full sm:max-w-md flex flex-col items-center animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="w-14 h-14 bg-indigo-500/10 border border-indigo-500/20 rounded-2xl flex items-center justify-center mb-6 shadow-lg shadow-indigo-500/10">
            <Shield className="text-indigo-400" size={28} strokeWidth={1.5} />
          </div>
          <h2 className="text-center text-3xl font-bold text-white tracking-tight">
            Workspace Administration
          </h2>
          <p className="mt-2 text-center text-sm text-gray-400 font-medium">
            Sign in with your master credentials to continue
          </p>
        </div>

        <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md animate-in fade-in zoom-in-95 duration-500 delay-100">
          <div className="bg-[#121827] py-8 px-4 shadow-2xl sm:rounded-2xl sm:px-10 border border-[#1F2937] relative overflow-hidden">
            
            {/* Subtle top gradient accent */}
            <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-indigo-500 to-transparent opacity-40" />

            {message && (
              <div className={`p-4 rounded-xl mb-6 text-sm font-medium flex items-center gap-3 border ${message.type === 'error' ? 'bg-red-500/10 text-red-400 border-red-500/20' : 'bg-green-500/10 text-green-400 border-green-500/20'}`}>
                <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${message.type === 'error' ? 'bg-red-400' : 'bg-green-400'}`} />
                {message.text}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Admin Email Address
                </label>
                <div className="mt-1">
                  <input 
                    required 
                    type="email" 
                    value={email} 
                    onChange={(e) => setEmail(e.target.value)} 
                    className="appearance-none block w-full px-4 py-3 border border-[#374151] rounded-xl shadow-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-[#0B101E] text-white text-sm transition-all" 
                    placeholder="admin@slick.com" 
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Security Password
                </label>
                <div className="mt-1 relative">
                  <input 
                    required 
                    type={showPassword ? 'text' : 'password'} 
                    value={password} 
                    onChange={(e) => setPassword(e.target.value)} 
                    className="appearance-none block w-full pl-4 pr-12 py-3 border border-[#374151] rounded-xl shadow-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-[#0B101E] text-white text-sm transition-all" 
                    placeholder="••••••••" 
                  />
                  <button 
                    type="button" 
                    onClick={() => setShowPassword(!showPassword)} 
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              <div className="pt-2">
                <button 
                  disabled={loading} 
                  type="submit" 
                  className="w-full flex justify-center items-center gap-2 py-3 px-4 border border-transparent rounded-xl shadow-sm text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-600 focus:ring-offset-[#121827] transition-all disabled:opacity-70 disabled:cursor-not-allowed"
                >
                  {loading ? <Loader2 size={18} className="animate-spin" /> : <><Lock size={16} /> Authenticate Session</>}
                </button>
              </div>
            </form>

            <div className="mt-8 pt-6 border-t border-[#1F2937]">
              <button 
                type="button" 
                onClick={toggleAdminMode} 
                className="w-full text-center text-sm font-medium text-gray-400 hover:text-white transition-colors flex items-center justify-center gap-2"
              >
                <ArrowRight size={14} className="rotate-180" /> Return to User Sign In
              </button>
            </div>

          </div>
        </div>
      </div>
    );
  }

  // ==========================================
  // 🌟 NORMAL USER UI (CLEAN & MODERN)
  // ==========================================
  return (
    <div className="min-h-screen bg-[#faf9fa] flex items-center justify-center p-4 md:p-8 font-sans">
      <div className="max-w-5xl w-full grid md:grid-cols-2 gap-12 lg:gap-24 items-center animate-in fade-in zoom-in-95 duration-500">
        
        {/* Left Side Info */}
        <div className="hidden md:flex flex-col gap-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-[#350d36] rounded-xl flex items-center justify-center text-white font-black text-xl shadow-lg">S</div>
            <span className="text-2xl font-black text-gray-900 tracking-tight">Slick</span>
          </div>
          <div>
            <h1 className="text-4xl lg:text-5xl font-black text-gray-900 tracking-tight leading-[1.1] mb-6">Welcome back to<br />the workspace.</h1>
            <p className="text-gray-500 text-base font-medium max-w-md leading-relaxed">Ditch the noise. Connect with your team in a beautifully designed space that facilitates focus and creativity.</p>
          </div>
          <div className="flex flex-col gap-6 mt-4">
            <div className="flex items-start gap-4">
              <div className="p-2.5 bg-green-50 text-green-600 rounded-xl shrink-0"><ShieldCheck size={20} /></div>
              <div><h3 className="font-bold text-gray-900 text-sm mb-1">Secure Database</h3><p className="text-xs text-gray-500 font-medium">Encryption at rest and in transit.</p></div>
            </div>
            <div className="flex items-start gap-4">
              <div className="p-2.5 bg-blue-50 text-blue-600 rounded-xl shrink-0"><Zap size={20} /></div>
              <div><h3 className="font-bold text-gray-900 text-sm mb-1">Instant Sync</h3><p className="text-xs text-gray-500 font-medium">Built on ultra-fast WebSocket cores.</p></div>
            </div>
          </div>
        </div>

        {/* Right Side Form */}
        <div className="bg-white p-8 lg:p-10 rounded-[2rem] shadow-[0_20px_40px_-15px_rgba(0,0,0,0.05)] border border-gray-100 relative">

          {!isLogin && signupStep === 'otp' ? (
            <>
              <button
                type="button"
                onClick={resetSignupFlow}
                className="flex items-center gap-1.5 text-xs font-bold text-gray-400 hover:text-gray-700 transition-colors mb-6"
              >
                <ArrowLeft size={14} /> Back
              </button>

              <div className="mb-8">
                <div className="w-12 h-12 rounded-xl bg-violet-50 border border-violet-100 flex items-center justify-center text-violet-600 mb-4">
                  <Mail size={22} />
                </div>
                <h2 className="text-2xl font-black text-gray-900 tracking-tight mb-2">Verify your email</h2>
                <p className="text-sm text-gray-400 font-medium">
                  Enter the 6-digit code sent to <span className="font-bold text-gray-600">{email}</span>
                </p>
              </div>

              <form onSubmit={handleVerifyOtp} className="space-y-6">
                <div className="flex justify-between gap-2" onPaste={handleOtpPaste}>
                  {otpDigits.map((digit, i) => (
                    <input
                      key={i}
                      ref={(el) => { otpInputRefs.current[i] = el; }}
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      autoFocus={i === 0}
                      onChange={(e) => handleOtpDigitChange(i, e.target.value)}
                      onKeyDown={(e) => handleOtpKeyDown(i, e)}
                      className="w-full aspect-square text-center text-xl font-black text-gray-900 bg-gray-50 border-2 border-transparent focus:border-violet-500 focus:bg-white focus:ring-4 focus:ring-violet-100 rounded-xl outline-none transition-all"
                    />
                  ))}
                </div>

                <div className="flex items-center justify-between text-xs font-bold">
                  <span className="text-gray-400">
                    {secondsLeft > 0 ? (
                      <>Code expires in <span className="text-gray-700 tabular-nums">{Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}</span></>
                    ) : (
                      <span className="text-red-500">Code expired</span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={handleResendCode}
                    disabled={secondsLeft > 0 || resending}
                    className="flex items-center gap-1.5 text-violet-600 hover:text-violet-800 disabled:text-gray-300 disabled:cursor-not-allowed transition-colors uppercase tracking-widest"
                  >
                    {resending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                    Resend Code
                  </button>
                </div>

                <button
                  disabled={verifying || otpDigits.some((d) => !d)}
                  type="submit"
                  className="w-full py-3.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl font-black text-sm flex items-center justify-center gap-2 transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-violet-600/20"
                >
                  {verifying ? <Loader2 size={18} className="animate-spin" /> : <>Verify & Continue <ArrowRight size={16} /></>}
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="flex p-1 bg-gray-50 rounded-xl mb-8">
                <button type="button" onClick={() => { setIsLogin(true); setMessage(null); resetSignupFlow(); }} className={`flex-1 py-2.5 text-sm font-black rounded-lg transition-all ${isLogin ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}>Login</button>
                <button type="button" onClick={() => { setIsLogin(false); setMessage(null); resetSignupFlow(); }} className={`flex-1 py-2.5 text-sm font-black rounded-lg transition-all ${!isLogin ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}>Sign Up</button>
              </div>

              <div className="mb-8">
                <h2 className="text-2xl font-black text-gray-900 tracking-tight mb-2">{isLogin ? 'Sign In' : 'Create Account'}</h2>
                <p className="text-sm text-gray-400 font-medium">{isLogin ? 'Enter your details to continue.' : "We'll email you a code to verify it's really you."}</p>
              </div>

              {message && (
                <div className={`p-4 rounded-xl mb-6 text-sm font-bold flex items-center gap-2 ${message.type === 'error' ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600'}`}>
                  <div className={`w-1.5 h-1.5 rounded-full ${message.type === 'error' ? 'bg-red-600' : 'bg-green-600'}`} />
                  {message.text}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-5">
                {!isLogin && (
                  <div>
                    <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1.5 block">Full Name</label>
                    <input required type="text" value={username} onChange={(e) => setUsername(e.target.value)} className="w-full bg-gray-50 border border-transparent focus:border-gray-200 focus:bg-white rounded-xl px-4 py-3 text-sm font-bold text-gray-900 outline-none transition-all placeholder:font-medium placeholder:text-gray-400" placeholder="Samarth Karale" />
                  </div>
                )}

                <div>
                  <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1.5 block">Email Address</label>
                  <input
                    required
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={!isLogin && !!presetEmail}
                    readOnly={!isLogin && !!presetEmail}
                    className="w-full bg-gray-50 border border-transparent focus:border-gray-200 focus:bg-white rounded-xl px-4 py-3 text-sm font-bold text-gray-900 outline-none transition-all placeholder:font-medium placeholder:text-gray-400 disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed"
                    placeholder="samarth@example.com"
                  />
                  {!isLogin && !!presetEmail && (
                    <p className="text-[11px] text-gray-400 font-medium mt-1.5">This invite was sent to this address.</p>
                  )}
                </div>

                <div className="relative">
                  <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1.5 block">Secret Password</label>
                  <input required type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} className="w-full bg-gray-50 border border-transparent focus:border-gray-200 focus:bg-white rounded-xl pl-4 pr-12 py-3 text-sm font-bold text-gray-900 outline-none transition-all placeholder:font-medium placeholder:text-gray-400" placeholder="••••••••" />
                  <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-4 top-[30px] text-gray-400 hover:text-gray-600 transition-colors">
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>

                {isLogin && (
                  <div className="flex justify-end mt-2">
                    <button type="button" onClick={handleForgotPassword} disabled={loading} className="text-xs font-bold text-[#350d36] hover:text-purple-900 transition-colors">
                      Forgot Password?
                    </button>
                  </div>
                )}

                <button disabled={loading} type="submit" className="w-full py-3.5 bg-[#350d36] hover:bg-[#4a154b] text-white rounded-xl font-black text-sm flex items-center justify-center gap-2 transition-all active:scale-[0.98] mt-6 shadow-lg shadow-purple-900/20 disabled:opacity-70">
                  {loading ? <Loader2 size={18} className="animate-spin" /> : <>{isLogin ? 'Sign In' : 'Send Verification Code'} <ArrowRight size={16} /></>}
                </button>
              </form>

              {/* Admin Portal Entry Point */}
              <div className="mt-8 flex justify-center items-center gap-3 border-t border-gray-100 pt-6">
                <button type="button" onClick={toggleAdminMode} className="text-[10px] font-bold text-gray-400 hover:text-gray-800 uppercase tracking-widest transition-colors">
                  Access Admin Portal
                </button>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  );
};