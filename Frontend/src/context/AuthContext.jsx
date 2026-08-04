import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../services/api";

/**
 * Who is signed in.
 *
 * Three states, and the third is the one that matters: `checking`. On load the
 * app does not yet know whether the refresh cookie will produce a session, and
 * a guard that treats "not known yet" as "signed out" bounces every returning
 * user to the login page for the length of one request.
 */
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState("checking"); // checking | authenticated | anonymous

  useEffect(() => {
    let cancelled = false;

    // The access token lives in memory, so a reload always starts with none.
    // The refresh cookie is what carries the session across it.
    api.resume().then((resumed) => {
      if (cancelled) return;
      setUser(resumed);
      setStatus(resumed ? "authenticated" : "anonymous");
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (credentials) => {
    const signedIn = await api.login(credentials);
    setUser(signedIn);
    setStatus("authenticated");
    return signedIn;
  }, []);

  const register = useCallback(async (details) => {
    const created = await api.register(details);
    setUser(created);
    setStatus("authenticated");
    return created;
  }, []);

  const logout = useCallback(async (options) => {
    await api.logout(options);
    setUser(null);
    setStatus("anonymous");
  }, []);

  const value = useMemo(
    () => ({
      user,
      status,
      isAuthenticated: status === "authenticated",
      isChecking: status === "checking",
      login,
      register,
      logout,
    }),
    [user, status, login, register, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside an AuthProvider");
  return context;
}

/**
 * Turn an `ApiError` into something worth showing.
 *
 * The backend's `kind` is the stable contract; its `message` is copy. Branching
 * on kind here means a reworded backend message cannot break the UI, and the
 * one case worth special handling — a rate limit — can say how long to wait.
 */
export function authErrorMessage(error) {
  if (!(error instanceof ApiError)) return "Something went wrong. Try again.";

  switch (error.kind) {
    case "unauthenticated":
      return error.message || "Email or password is incorrect.";
    case "conflict":
      return "An account with that email already exists.";
    case "validation":
      return error.message || "Check the details and try again.";
    case "rate_limited": {
      const seconds = error.details?.retryAfterSeconds;
      return seconds
        ? `Too many attempts. Try again in about ${Math.ceil(seconds / 60)} minute(s).`
        : "Too many attempts. Try again shortly.";
    }
    case "forbidden":
      return "Registration is closed on this deployment.";
    default:
      return "We could not reach the server. Try again.";
  }
}
