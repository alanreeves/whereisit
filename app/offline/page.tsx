"use client";

export default function OfflinePage() {
  return (
    <div className="auth-screen">
      <div className="glass auth-card" style={{ textAlign: "center" }}>
        <div style={{ fontSize: "4rem", marginBottom: "1rem" }}>📡</div>
        <h1 className="auth-title">You are offline</h1>
        <p className="auth-subtitle">
          Where Is It? cannot reach the server.<br />
          Please check your connection and try again.
        </p>
        <button className="btn btn--primary btn--full" onClick={() => window.location.reload()}>
          Try Again
        </button>
      </div>
    </div>
  );
}
