"use client";

import React, { useEffect } from "react";
import { useParams } from "next/navigation";
import { ProjectProvider, useProject } from "@/lib/project-context";
import { useShell } from "@/components/shell";

/**
 * Project routes.
 *
 * The chrome (icon rail, sidebar, topbar) is the app-wide shell in
 * components/shell.tsx — it renders above this layout, so all this does is
 * load the project and hand it up to the shell for the switcher, breadcrumb
 * and rail deep-links.
 */
function ProjectShellBridge({ children }: { children: React.ReactNode }) {
  const { project } = useProject();
  const { setProject } = useShell();

  useEffect(() => {
    if (project) setProject(project);
  }, [project, setProject]);

  return <>{children}</>;
}

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? params.id : String(params?.id ?? "");

  return (
    <ProjectProvider projectId={id}>
      <ProjectShellBridge>{children}</ProjectShellBridge>
    </ProjectProvider>
  );
}
