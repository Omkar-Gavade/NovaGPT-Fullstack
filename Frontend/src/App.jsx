import { Routes, Route } from "react-router-dom";

import HomePage from "./pages/HomePage";
import PricingPage from "./pages/PricingPage";
import DocsPage from "./pages/DocsPage";
import AuthPage from "./pages/AuthPage";

import { useTheme } from "./context/ThemeContext";
import { AuthProvider } from "./context/AuthContext";
import { ChatProvider } from "./context/ChatContext";
import RequireAuth from "./components/auth/RequireAuth";
import ChatLayout from "./components/layout/ChatLayout";

function App() {
  const { isDark, toggleTheme } = useTheme();

  return (
    <AuthProvider>
      <Routes>
      {/* LANDING */}
      <Route path="/" element={<HomePage />} />

      {/* CHAT */}
      <Route
        path="/chat"
        element={
          <RequireAuth>
            <ChatProvider>
              <ChatLayout />
            </ChatProvider>
          </RequireAuth>
        }
      />

      <Route
        path="/pricing"
        element={<PricingPage isDark={isDark} toggleTheme={toggleTheme} />}
      />
      <Route
        path="/docs"
        element={<DocsPage isDark={isDark} toggleTheme={toggleTheme} />}
      />
      <Route path="/auth" element={<AuthPage />} />
      </Routes>
    </AuthProvider>
  );
}

export default App;
