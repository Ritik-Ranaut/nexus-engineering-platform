import { Navigate, Outlet } from "react-router-dom";
import { useAuthStore } from "../state/auth.store";

export function ProtectedRoute() {
  const { user, initialized } = useAuthStore();
  if (!initialized) {
    return <main className="loading-screen" aria-label="Checking session"><span className="loading-orbit" /></main>;
  }
  return user ? <Outlet /> : <Navigate to="/login" replace />;
}
