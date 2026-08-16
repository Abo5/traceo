"use client";

import React from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { ProjectProvider, useProject } from "@/lib/project-context";
import { Badge } from "@/components/ui";

const NAV_GROUPS: { label: string; items: { seg: string; label: string }[] }[] = [
  {
    label: "Workspace",
    items: [
      { seg: "", label: "Overview" },
      { seg: "requirements", label: "Requirements" },
      { seg: "endpoints", label: "Endpoints" },
      { seg: "target", label: "Target" },
    ],
  },
  {
    label: "Analysis",
    items: [
      { seg: "generate", label: "Generate" },
      { seg: "insights", label: "Insights" },
      { seg: "review", label: "Review" },
      { seg: "runs", label: "Runs" },
      { seg: "matrix", label: "Matrix" },
    ],
  },
  {
    label: "Configure",
    items: [
      { seg: "environments", label: "Environments" },
      { seg: "settings", label: "Settings" },
      { seg: "integrations", label: "Integrations" },
    ],
  },
  {
    label: "Reference",
    items: [{ seg: "reference", label: "Reference" }],
  },
];

function Sidebar({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const { project } = useProject();

  const base = `/projects/${projectId}`;

  return (
    <aside className="sidebar" data-testid="nav-project-sidebar">
      <div className="sidebar-head">
        <div className="sidebar-project" title={project?.name ?? ""} data-testid="nav-project-name">
          {project?.name ?? "…"}
        </div>
        <div className="row" style={{ gap: 6 }}>
          {project?.status === "archived" && (
            <Badge tone="muted" testId="nav-project-archived-badge">Archived</Badge>
          )}
        </div>
      </div>
      <nav className="sidebar-nav">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} style={{ marginBottom: 6 }}>
            <div
              className="eyebrow"
              style={{ padding: "10px 12px 4px", fontSize: 10.5, color: "var(--text-secondary)" }}
            >
              {group.label}
            </div>
            {group.items.map((item) => {
              const href = item.seg ? `${base}/${item.seg}` : base;
              const active = item.seg
                ? pathname === href || pathname.startsWith(`${href}/`)
                : pathname === base || pathname === `${base}/`;
              return (
                <Link
                  key={item.seg || "overview"}
                  href={href}
                  className={`nav-item ${active ? "nav-item-active" : ""}`}
                  data-testid={`nav-link-${item.seg || "overview"}`}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? params.id : String(params?.id ?? "");

  return (
    <ProjectProvider projectId={id}>
      <div className="project-shell" data-testid="nav-project-shell">
        <Sidebar projectId={id} />
        <div className="project-main">{children}</div>
      </div>
    </ProjectProvider>
  );
}
