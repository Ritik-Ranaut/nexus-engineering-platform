import { Navigate } from "react-router-dom";
import { AuthForm } from "../components/AuthForm";
import { AuthLayout } from "../components/AuthLayout";
import { useAuthStore } from "../state/auth.store";

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const user = useAuthStore((state) => state.user);
  if (user) return <Navigate to="/workspace" replace />;
  return <AuthLayout mode={mode}><AuthForm mode={mode} /></AuthLayout>;
}
