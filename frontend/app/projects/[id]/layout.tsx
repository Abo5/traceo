"use client";

import React from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { ProjectProvider, useProject } from "@/lib/project-context";
import { useLang } from "@/lib/i18n";
import { Badge } from "@/components/ui";

const NAV_GROUPS: { ar: string; en: string; items: { seg: string; ar: string; en: string }[] }[] = [
  {
    ar: "مساحة العمل",
    en: "Workspace",
    items: [
      { seg: "", ar: "نظرة عامة", en: "Overview" },
      { seg: "requirements", ar: "المتطلبات", en: "Requirements" },
      { seg: "endpoints", ar: "الواجهات", en: "Endpoints" },
    ],
  },
  {
    ar: "التحليل",
    en: "Analysis",
    items: [
      { seg: "generate", ar: "التوليد", en: "Generate" },
      { seg: "review", ar: "المراجعة", en: "Review" },
      { seg: "runs", ar: "التشغيلات", en: "Runs" },
      { seg: "matrix", ar: "المصفوفة", en: "Matrix" },
    ],
  },
  {
    ar: "الإعداد",
    en: "Configure",
    items: [{ seg: "environments", ar: "البيئات", en: "Environments" }],
  },
];

function Sidebar({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const { project } = useProject();
  const { lang } = useLang();
  const ar = lang === "ar";

  const base = `/projects/${projectId}`;

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-project" title={project?.name ?? ""}>
          {project?.name ?? "…"}
        </div>
        <div className="row" style={{ gap: 6 }}>
          {project?.language && (
            <Badge tone="accent">
              {project.language === "ar" ? (ar ? "العربية" : "Arabic") : ar ? "الإنجليزية" : "English"}
            </Badge>
          )}
          {project?.status === "archived" && (
            <Badge tone="muted">{ar ? "مؤرشف" : "Archived"}</Badge>
          )}
        </div>
      </div>
      <nav className="sidebar-nav">
        {NAV_GROUPS.map((group) => (
          <div key={group.en} style={{ marginBottom: 6 }}>
            <div
              className="eyebrow"
              style={{ padding: "10px 12px 4px", fontSize: 10.5, color: "var(--text-muted)" }}
            >
              {ar ? group.ar : group.en}
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
                >
                  {ar ? item.ar : item.en}
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
      <div className="project-shell">
        <Sidebar projectId={id} />
        <div className="project-main">{children}</div>
      </div>
    </ProjectProvider>
  );
}
