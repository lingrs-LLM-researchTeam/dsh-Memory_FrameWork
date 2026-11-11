import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Dashboard } from "./dashboard.js";
import { styles } from "./styles.js";
import type { Call } from "./contracts.js";

function Standalone() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void fetch("/dashboard/session", {
      signal: abort.signal,
      credentials: "same-origin",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((session: unknown) => {
        if (
          !abort.signal.aborted &&
          session &&
          typeof session === "object" &&
          "authenticated" in session
        )
          setLoggedIn(session.authenticated === true);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!abort.signal.aborted) setCheckingSession(false);
      });
    return () => abort.abort();
  }, []);
  const call: Call = useCallback(
    async (operation, payload = {}, sessionId, signal) => {
      const response = await fetch("/v1/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          operation,
          payload,
          session_id: sessionId || null,
        }),
        signal,
      });
      if (response.status === 401) {
        setLoggedIn(false);
        throw new Error("登录已过期，请重新登录");
      }
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message || result.detail || "操作失败");
      return result;
    },
    [],
  );
  if (checkingSession)
    return (
      <div className="mf-app">
        <style>{styles}</style>
        <p className="mf-login">正在检查本地登录状态…</p>
      </div>
    );
  if (loggedIn) return <Dashboard call={call} />;
  return (
    <div className="mf-app">
      <style>{styles}</style>
      <div className="mf-login">
        <div className="mf-brand">
          <span className="mf-logo" aria-hidden="true" />
          Memory Framework
        </div>
        <h1 style={{ marginTop: 30 }}>连接你的记忆工作区</h1>
        <p>输入本地管理令牌以打开控制台。</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError("");
            void fetch("/dashboard/login", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token }),
            })
              .then((response) => {
                if (!response.ok) throw new Error("登录失败，请检查管理令牌");
                setToken("");
                setLoggedIn(true);
              })
              .catch((e) => setError(String(e)));
          }}
        >
          <label>
            管理令牌
            <input
              aria-label="管理令牌"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
            />
          </label>
          {error && (
            <div role="alert" className="mf-notice error">
              {error}
            </div>
          )}
          <button className="mf-btn primary" type="submit">
            打开 Dashboard
          </button>
        </form>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Standalone />);
