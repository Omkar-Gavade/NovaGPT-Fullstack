import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";

/**
 * Gate a route on a signed-in session.
 *
 * The `checking` state is the reason this is a component rather than a
 * one-line conditional. On load the app does not yet know whether the refresh
 * cookie will produce a session, and treating "not known yet" as "signed out"
 * bounces every returning user to the login page — briefly, visibly, and every
 * single time.
 *
 * This is a *convenience*, not a security control. The real enforcement is the
 * backend refusing the request; a guard in the browser is something the user
 * can remove from their own devtools.
 */
export default function RequireAuth({ children }) {
  const { isAuthenticated, isChecking } = useAuth();
  const location = useLocation();

  if (isChecking) {
    return (
      <div className="auth-gate" role="status" aria-live="polite">
        <span className="auth-gate__spinner" aria-hidden="true" />
        <p>Restoring your session…</p>
      </div>
    );
  }

  // `state` carries where they were headed, so signing in lands them there
  // rather than on a generic home screen.
  if (!isAuthenticated) {
    return <Navigate to="/auth" replace state={{ from: location.pathname }} />;
  }

  return children;
}
