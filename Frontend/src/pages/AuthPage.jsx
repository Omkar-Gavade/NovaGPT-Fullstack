import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import {
  Sun, Moon, Mail, Lock, User, Eye, EyeOff,
  AlertCircle, CheckCircle2,
} from "lucide-react";
import { useTheme } from "../context/ThemeContext";
import { useAuth, authErrorMessage } from "../context/AuthContext";
import AuthConstellation from "../components/auth/AuthConstellation";

const COPY = {
  login: { title: "Welcome back", sub: "Sign in to your AI workspace.", cta: "Sign in" },
  register: { title: "Create your account", sub: "One workspace for every model.", cta: "Create account" },
};

/**
 * The backend's minimum, mirrored.
 *
 * Length over composition rules: `Passw0rd!` satisfies every character-class
 * requirement and is weaker than a longer passphrase. The server enforces this
 * too — this copy exists so the rule is visible before the round trip, not
 * instead of it.
 */
const MIN_PASSWORD = 12;

const emailOk = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

export default function AuthPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isDark, toggleTheme } = useTheme();
  const { login, register, isAuthenticated } = useAuth();

  // Where the route guard sent them from, so signing in resumes the thing they
  // were trying to do rather than dropping them on a generic screen.
  const destination = location.state?.from ?? "/chat";
  const reduce = useReducedMotion();
  const emailRef = useRef(null);

  const [mode, setMode] = useState("login"); // login | register
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(null); // {type:'error'|'ok', text}

  const copy = COPY[mode];

  // A signed-in visitor has no business on the sign-in page.
  useEffect(() => {
    if (isAuthenticated) navigate(destination, { replace: true });
  }, [isAuthenticated, destination, navigate]);

  // focus email whenever the mode changes
  useEffect(() => {
    const id = setTimeout(() => emailRef.current?.focus(), 60);
    return () => clearTimeout(id);
  }, [mode]);

  const swap = (next) => {
    setErrs({});
    setBanner(null);
    setMode(next);
  };

  const fieldError = (field, value) => {
    if (field === "email") return emailOk(value) ? "" : "Enter a valid email address.";
    if (field === "password") {
      // Only enforced when creating an account: an existing password that
      // predates the rule must still be able to sign in.
      if (mode === "login") return value.length > 0 ? "" : "Enter your password.";
      return value.length >= MIN_PASSWORD ? "" : `At least ${MIN_PASSWORD} characters.`;
    }
    return "";
  };

  const onBlur = (field, value) => {
    if (value === "") return; // don't nag empty fields on blur; submit enforces required
    setErrs((e) => ({ ...e, [field]: fieldError(field, value) }));
  };

  const validate = () => {
    const next = {
      email: fieldError("email", email),
      password: fieldError("password", password),
    };
    setErrs(next);
    return !Object.values(next).some(Boolean);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBanner(null);
    if (!validate()) return;
    setBusy(true);
    try {
      if (mode === "login") await login({ email, password });
      else await register({ email, password, displayName: name.trim() || undefined });
      navigate(destination);
    } catch (err) {
      // Branches on the error `kind`, never on message text — the wording is
      // copy the backend may change freely.
      setBanner({ type: "error", text: authErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit(e);
  };

  // staggered entrance
  const container = { hidden: {}, show: { transition: { staggerChildren: 0.055, delayChildren: 0.04 } } };
  const item = reduce
    ? {}
    : { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } } };

  return (
    <div className="auth-stage">
      <AuthConstellation isDark={isDark} />
      <div className="auth-veil" />

      <div className="auth-topbar">
        <Link to="/" className="auth-brand">
          <span className="brand-logo">N</span>
          <span className="brand-title">NovaGPT</span>
        </Link>
        <button className="auth-topbtn" onClick={toggleTheme} aria-label="Toggle theme">
          {isDark ? <Sun size={17} /> : <Moon size={17} />}
        </button>
      </div>

      <motion.div
        className="auth-console"
        initial={reduce ? false : { opacity: 0, y: 18, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="auth-status">
          <span className="live-dot" /> 11 models online
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={mode}
            variants={container}
            initial="hidden"
            animate="show"
            exit={reduce ? undefined : { opacity: 0, transition: { duration: 0.15 } }}
          >
            <motion.h1 className="auth-title" variants={item}>{copy.title}</motion.h1>
            <motion.p className="auth-sub" variants={item}>{copy.sub}</motion.p>

            {banner && (
              <motion.div className={`auth-banner auth-banner--${banner.type === "ok" ? "ok" : "error"}`} variants={item}>
                {banner.type === "ok" ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                {banner.text}
              </motion.div>
            )}

            <form onSubmit={submit} onKeyDown={onKeyDown} noValidate>
              {mode === "register" && (
                <motion.div variants={item}>
                  <Field id="auth-name" label="Name" icon={User}>
                    <input
                      id="auth-name"
                      className="field-input"
                      type="text"
                      placeholder="Your name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      autoComplete="name"
                    />
                  </Field>
                </motion.div>
              )}

              <motion.div variants={item}>
                <Field id="auth-email" label="Email" icon={Mail} error={errs.email}>
                  <input
                    id="auth-email"
                    ref={emailRef}
                    className="field-input"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onBlur={(e) => onBlur("email", e.target.value)}
                    aria-invalid={errs.email ? "true" : undefined}
                    aria-describedby={errs.email ? "auth-email-msg" : undefined}
                    autoComplete="email"
                    required
                  />
                </Field>
              </motion.div>

              <motion.div variants={item}>
                  <Field id="auth-password" label="Password" icon={Lock} error={errs.password}>
                    <input
                      id="auth-password"
                      className="field-input"
                      type={showPw ? "text" : "password"}
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onBlur={(e) => onBlur("password", e.target.value)}
                      aria-invalid={errs.password ? "true" : undefined}
                      aria-describedby={errs.password ? "auth-password-msg" : undefined}
                      autoComplete={mode === "login" ? "current-password" : "new-password"}
                      required
                    />
                    <button
                      type="button"
                      className="field-toggle"
                      onClick={() => setShowPw((v) => !v)}
                      aria-label={showPw ? "Hide password" : "Show password"}
                    >
                      {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </Field>
              </motion.div>

              <motion.button
                type="submit"
                className="auth-submit"
                disabled={busy}
                variants={item}
                whileHover={reduce ? undefined : { scale: 1.015 }}
                whileTap={reduce ? undefined : { scale: 0.98 }}
              >
                {busy ? "Please wait…" : copy.cta}
                {!busy && <span className="kbd">⌘↵</span>}
              </motion.button>
            </form>

            <motion.p className="auth-switch" variants={item}>
              {mode === "login" ? "New to NovaGPT?" : "Already have an account?"}{" "}
              <button onClick={() => swap(mode === "login" ? "register" : "login")}>
                {mode === "login" ? "Create account" : "Sign in"}
              </button>
            </motion.p>
          </motion.div>
        </AnimatePresence>
      </motion.div>

      <p className="auth-foot">Secure sign-in · Your keys, your data</p>
    </div>
  );
}

function Field({ id, label, icon: Icon, error, children }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      <div className="field-input-wrap">
        <Icon className="field-icon" size={16} />
        {children}
      </div>
      {error && (
        <p className="field-msg" id={`${id}-msg`}>
          <AlertCircle size={13} /> {error}
        </p>
      )}
    </div>
  );
}
