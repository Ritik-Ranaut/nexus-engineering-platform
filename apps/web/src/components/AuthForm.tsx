import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { useAuthStore } from "../state/auth.store";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const isRegister = mode === "register";
  const navigate = useNavigate();
  const { login, register, loading, error: storeError, clearError } = useAuthStore();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    clearError();
    setFormError(null);
    try {
      if (isRegister) await register({ name, email, password });
      else await login({ email, password });
      navigate("/workspace", { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.details?.length) {
        setFormError(error.details.map((detail) => `${detail.path}: ${detail.message}`).join(" · "));
      }
    }
  };

  return (
    <div className="auth-content">
      <div className="form-heading">
        <span className="form-kicker">{isRegister ? "GET STARTED" : "WELCOME BACK"}</span>
        <h2>{isRegister ? "Create your account" : "Sign in to NEXUS"}</h2>
        <p>{isRegister ? "Start with a workspace that's ready for your code." : "Your engineering workspace is waiting."}</p>
      </div>
      <form className="auth-form" onSubmit={submit}>
        {isRegister && (
          <label className="field">
            <span>Full name</span>
            <input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} required placeholder="Ada Lovelace" />
          </label>
        )}
        <label className="field">
          <span>Email address</span>
          <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} required placeholder="you@company.com" />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete={isRegister ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={isRegister ? 12 : 1} maxLength={128} required placeholder={isRegister ? "At least 12 characters" : "Enter your password"} />
        </label>
        {(formError || storeError) && <div className="form-alert" role="alert">{formError ?? storeError}</div>}
        <button className="primary-button" disabled={loading} type="submit">
          {loading ? <><span className="button-spinner" /> {isRegister ? "Creating account…" : "Signing in…"}</> : <>{isRegister ? "Create account" : "Sign in"} <span aria-hidden="true">→</span></>}
        </button>
      </form>
      <p className="switch-auth">
        {isRegister ? "Already have an account?" : "New to NEXUS?"}{" "}
        <Link to={isRegister ? "/login" : "/register"}>{isRegister ? "Sign in" : "Create an account"}</Link>
      </p>
      <p className="security-note"><span className="lock-icon" aria-hidden="true">◇</span> Your code and account data stay yours.</p>
    </div>
  );
}
