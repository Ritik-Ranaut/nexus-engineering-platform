import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { AuthPage } from "./pages/AuthPage";
import { WorkspacePage } from "./pages/WorkspacePage";
import { ProjectChatPage } from "./pages/ProjectChatPage";
import { EngineeringIssuesPage } from "./pages/EngineeringIssuesPage";
import { MissionCenterPage } from "./pages/MissionCenterPage";
import { CodeExplorerPage } from "./pages/CodeExplorerPage";
import { EngineeringReportsPage } from "./pages/EngineeringReportsPage";
import { FixProposalsPage } from "./pages/FixProposalsPage";
import { ArchitectureExplorerPage } from "./pages/ArchitectureExplorerPage";
import { useAuthStore } from "./state/auth.store";
import "./styles.css";

function App() {
  const initialize = useAuthStore((state) => state.initialize);
  React.useEffect(() => {
    void initialize();
  }, [initialize]);

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/workspace" replace />} />
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route element={<ProtectedRoute />}>
        <Route path="/workspace" element={<WorkspacePage />} />
        <Route path="/projects/:projectId/chat" element={<ProjectChatPage />} />
        <Route path="/projects/:projectId/explorer" element={<CodeExplorerPage />} />
        <Route path="/projects/:projectId/architecture" element={<ArchitectureExplorerPage />} />
        <Route path="/projects/:projectId/issues" element={<EngineeringIssuesPage />} />
        <Route path="/projects/:projectId/missions" element={<MissionCenterPage />} />
        <Route path="/projects/:projectId/reports" element={<EngineeringReportsPage />} />
        <Route path="/projects/:projectId/fixes" element={<FixProposalsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/workspace" replace />} />
    </Routes>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><BrowserRouter><App /></BrowserRouter></React.StrictMode>
);
