import type { ReactNode } from "react";

const signals = [
  { label: "Project structure", value: "Files, layers, and imports" },
  { label: "Grounded answers", value: "Source paths and line ranges" }
];

export function AuthLayout({ children, mode }: { children: ReactNode; mode: "login" | "register" }) {
  return (
    <main className="auth-shell">
      <section className="auth-story">
        <a className="brand" href="/" aria-label="NEXUS home">
          <span className="brand-mark">N</span>
          <span>NEXUS<span className="brand-period">.</span></span>
        </a>
        <div className="story-copy">
          <div className="eyebrow"><span className="status-dot" /> ENGINEERING INTELLIGENCE</div>
          <h1>Understand a codebase<br /><span>from its source.</span></h1>
          <p>Map files and imports, then trace project answers back to the source they came from.</p>
        </div>
        <div className="story-signals">
          {signals.map((signal, index) => (
            <div className="signal" key={signal.label}>
              <span className="signal-index">0{index + 1}</span>
              <div><strong>{signal.label}</strong><span>{signal.value}</span></div>
            </div>
          ))}
        </div>
        <span className="story-grid" aria-hidden="true" />
      </section>
      <section className="auth-panel">
        <div className="mobile-brand"><span className="brand-mark">N</span>NEXUS<span className="brand-period">.</span></div>
        {children}
        <footer className="auth-footer">
          <span>{mode === "login" ? "New to NEXUS?" : "Already have an account?"}</span>
          <span className="footer-note">Code exploration with source context.</span>
        </footer>
      </section>
    </main>
  );
}
