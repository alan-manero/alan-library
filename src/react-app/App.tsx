import { useEffect, useState } from "react";
import { LoginScreen } from "./LoginScreen";
import { Library } from "./Library";

type AuthState = "checking" | "logged-out" | "logged-in";

export default function App() {
  const [auth, setAuth] = useState<AuthState>("checking");

  useEffect(() => {
    fetch("/api/auth/me").then((res) =>
      setAuth(res.ok ? "logged-in" : "logged-out")
    );
  }, []);

  if (auth === "checking") {
    return <div className="centered muted">Loading…</div>;
  }

  if (auth === "logged-out") {
    return <LoginScreen onSuccess={() => setAuth("logged-in")} />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">▞</span> ALAN LIBRARY
        </div>
        <nav className="nav">
          <a className="nav-link active">Library</a>
          <a className="nav-link disabled" title="Coming in a later phase">
            Imports
          </a>
          <a className="nav-link disabled" title="Coming in a later phase">
            Settings
          </a>
        </nav>
        <button
          className="ghost-button"
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            setAuth("logged-out");
          }}
        >
          Log out
        </button>
      </header>

      <main className="app-main">
        <Library />
      </main>
    </div>
  );
}
