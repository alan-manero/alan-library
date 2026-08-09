import { useEffect, useState } from "react";
import { LoginScreen } from "./LoginScreen";
import { Library } from "./Library";
import { Videos } from "./Videos";

type AuthState = "checking" | "logged-out" | "logged-in";
type Page = "library" | "videos";

export default function App() {
  const [auth, setAuth] = useState<AuthState>("checking");
  const [page, setPage] = useState<Page>("library");
  const [jumpImageId, setJumpImageId] = useState<string | null>(null);

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
          <a
            className={`nav-link ${page === "library" ? "active" : ""}`}
            onClick={() => setPage("library")}
          >
            Library
          </a>
          <a
            className={`nav-link ${page === "videos" ? "active" : ""}`}
            onClick={() => setPage("videos")}
          >
            Videos
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
        {/* The Library stays mounted while browsing Videos so in-progress
            uploads and AI analysis keep running in the background. */}
        <div
          style={{ display: page === "library" ? "contents" : "none" }}
        >
          <Library
            hidden={page !== "library"}
            openImageId={jumpImageId}
            onOpenImageHandled={() => setJumpImageId(null)}
          />
        </div>
        {page === "videos" && (
          <Videos
            onOpenImage={(imageId) => {
              setJumpImageId(imageId);
              setPage("library");
            }}
          />
        )}
      </main>
    </div>
  );
}
