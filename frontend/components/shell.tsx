"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api, getUser } from "@/lib/api";

/* ============================================================
   App shell — 64px icon rail · 232px sidebar · 56px topbar
   Ported from the v3 design (Traceo-All-Designs.html).
   ============================================================ */

// ---------- shell context ----------

type ShellProject = { id: string; name: string; status?: string } & Record<string, any>;

type ShellCtx = {
  project: ShellProject | null;
  /** Called by the project layout once the project loads, so the switcher,
   *  breadcrumb and rail deep-links can name it. */
  setProject: (p: ShellProject | null) => void;
};

const Ctx = createContext<ShellCtx>({ project: null, setProject: () => {} });

export function useShell(): ShellCtx {
  return useContext(Ctx);
}

// ---------- rail ----------

const ICON = {
  home: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <rect x="2.5" y="4" width="13" height="11" rx="3" />
      <line x1="5" y1="1.8" x2="13" y2="1.8" />
    </svg>
  ),
  runs: (
    <svg viewBox="0 0 18 18" fill="currentColor" aria-hidden>
      <path d="M5 3l10 6-10 6z" />
    </svg>
  ),
  rules: (
    <svg viewBox="0 0 18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <line x1="3" y1="4.5" x2="15" y2="4.5" />
      <line x1="3" y1="9" x2="15" y2="9" />
      <line x1="3" y1="13.5" x2="15" y2="13.5" />
    </svg>
  ),
  bugs: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <circle cx="9" cy="9" r="6" />
      <circle cx="9" cy="9" r="2" fill="currentColor" />
    </svg>
  ),
  docs: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <rect x="3.5" y="2" width="11" height="14" rx="2" />
      <line x1="6" y1="8" x2="12" y2="8" />
    </svg>
  ),
  admin: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <circle cx="9" cy="9" r="6.5" />
      <circle cx="9" cy="9" r="2.2" fill="currentColor" />
    </svg>
  ),
};

type RailItem = { key: string; label: string; icon: React.ReactNode; href: string; match: (p: string) => boolean };

function railItems(projectId: string | null): RailItem[] {
  const base = projectId ? `/projects/${projectId}` : "/projects";
  const inProject = (seg: string) => (p: string) =>
    Boolean(projectId) && p.startsWith(`${base}/${seg}`);
  return [
    {
      key: "home",
      label: "Home",
      icon: ICON.home,
      href: base,
      match: (p) => p === "/projects" || p === base || p === `${base}/`,
    },
    {
      key: "runs",
      label: "Runs",
      icon: ICON.runs,
      href: projectId ? `${base}/runs` : "/projects",
      match: inProject("runs"),
    },
    {
      key: "rules",
      label: "Rules",
      icon: ICON.rules,
      href: projectId ? `${base}/requirements` : "/projects",
      match: inProject("requirements"),
    },
    {
      key: "reports",
      label: "Reports",
      icon: ICON.docs,
      href: projectId ? `${base}/reports` : "/reports",
      match: (p) => p.startsWith("/reports") || inProject("reports")(p),
    },
    {
      key: "admin",
      label: "Admin",
      icon: ICON.admin,
      href: "/settings/members",
      match: (p) => p.startsWith("/settings"),
    },
  ];
}

function Rail({ projectId, initials }: { projectId: string | null; initials: string }) {
  const pathname = usePathname() ?? "";
  const items = railItems(projectId);
  return (
    <nav className="rail" data-testid="nav-rail" aria-label="Sections">
      <Link href="/projects" className="rail-logo" aria-label="Traceo home">
        T
      </Link>
      {items.map((it) => (
        <Link
          key={it.key}
          href={it.href}
          className={`ritem ${it.match(pathname) ? "ritem-active" : ""}`}
          data-testid={`nav-rail-${it.key}`}
          aria-current={it.match(pathname) ? "page" : undefined}
        >
          {it.icon}
          {it.label}
        </Link>
      ))}
      <span className="rail-avatar" aria-hidden>
        {initials}
      </span>
    </nav>
  );
}

// ---------- sidebar ----------

export type NavGroup = { label: string; items: { seg: string; label: string; href: string }[] };

/** Project-scoped navigation — every route the app has. */
function projectNav(base: string): NavGroup[] {
  return [
    {
      label: "Workspace",
      items: [
        { seg: "overview", label: "Overview", href: base },
        { seg: "requirements", label: "Requirements", href: `${base}/requirements` },
        { seg: "runs", label: "Runs", href: `${base}/runs` },
        // Inside a project, Reports means THIS project's reports. The
        // workspace-level /reports (one row per project) stays on the workspace
        // sidebar, where "which project is in trouble" is the live question.
        { seg: "reports", label: "Reports", href: `${base}/reports` },
      ],
    },
  ];
}

/** Workspace-scoped navigation — used outside a project. */
const WORKSPACE_NAV: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { seg: "projects", label: "Projects", href: "/projects" },
      { seg: "reports", label: "Reports", href: "/reports" },
    ],
  },
  {
    label: "Account",
    items: [
      { seg: "members", label: "Members", href: "/settings/members" },
      { seg: "audit", label: "Audit log", href: "/settings/audit" },
    ],
  },
];

function isActive(pathname: string, href: string, base: string | null): boolean {
  if (base && href === base) return pathname === base || pathname === `${base}/`;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function Sidebar({
  project,
  projectId,
  projectCount,
}: {
  project: ShellProject | null;
  projectId: string | null;
  projectCount: number | null;
}) {
  const pathname = usePathname() ?? "";
  const base = projectId ? `/projects/${projectId}` : null;
  const groups = base ? projectNav(base) : WORKSPACE_NAV;

  const title = base ? project?.name ?? "…" : "Workspace";
  const sub = base
    ? project?.status === "archived"
      ? "Archived project"
      : project?.automation
        ? `${project.automation} automation`
        : "Project"
    : projectCount === null
      ? "All projects"
      : `${projectCount} project${projectCount === 1 ? "" : "s"}`;

  return (
    <aside className="sidebar" data-testid="nav-project-sidebar">
      <Link
        href="/projects"
        className="switcher"
        data-testid="nav-project-switcher"
        title={base ? "Back to all projects" : "All projects"}
      >
        <span className="sav" aria-hidden>
          {(title || "?").trim().charAt(0).toUpperCase()}
        </span>
        <span className="switcher-body">
          <span className="switcher-name" data-testid="nav-project-name">
            {title}
          </span>
          <span className="switcher-sub">
            {project?.status === "archived" && (
              <span className="badge badge-muted" data-testid="nav-project-archived-badge">
                Archived
              </span>
            )}
            {project?.status === "archived" ? " " : sub}
          </span>
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: 11 }} aria-hidden>
          ⌄
        </span>
      </Link>

      <nav className="sidebar-nav" aria-label="Pages">
        {groups.map((group) => (
          <div key={group.label}>
            <div className="nlabel">{group.label}</div>
            {group.items.map((item) => {
              const active = isActive(pathname, item.href, base);
              return (
                <Link
                  key={item.seg}
                  href={item.href}
                  className={`nav-item ${active ? "nav-item-active" : ""}`}
                  data-testid={`nav-link-${item.seg === "overview" ? "overview" : item.seg}`}
                  aria-current={active ? "page" : undefined}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <ProjectMeter projectId={projectId} projectCount={projectCount} />
    </aside>
  );
}

/**
 * The design pins a plan/usage meter to the foot of the sidebar. This build has
 * no billing, so the slot shows something the backend can actually answer:
 * traceability coverage for the open project, or the project count above it.
 */
function ProjectMeter({
  projectId,
  projectCount,
}: {
  projectId: string | null;
  projectCount: number | null;
}) {
  const [coverage, setCoverage] = useState<{ pct: number; confirmed: number; total: number } | null>(
    null
  );

  useEffect(() => {
    let alive = true;
    if (!projectId) {
      setCoverage(null);
      return;
    }
    (async () => {
      try {
        const d = await api<any>(`/projects/${projectId}/dashboard`);
        if (!alive) return;
        setCoverage({
          pct: Math.max(0, Math.min(100, Number(d?.coverage_pct ?? 0))),
          confirmed: Number(d?.confirmed_count ?? 0),
          total: Number(d?.requirement_count ?? 0),
        });
      } catch {
        if (alive) setCoverage(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);

  if (!projectId) {
    return (
      <div className="usage" data-testid="nav-usage">
        <div className="usage-head">
          Projects
          <span className="usage-count">{projectCount ?? "—"}</span>
        </div>
        <Link
          href="/projects"
          className="btn btn-primary"
          style={{ justifyContent: "center", padding: "7px 0", fontSize: 11.5 }}
        >
          New project
        </Link>
      </div>
    );
  }

  const pct = coverage?.pct ?? 0;
  return (
    <div className="usage" data-testid="nav-usage">
      <div className="usage-head">
        Coverage
        <span className="usage-count">
          {coverage ? `${Math.round(coverage.pct)}%` : "—"}
        </span>
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-label="Requirement coverage"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <i className={pct >= 90 ? "ok" : pct >= 60 ? "" : "warn"} style={{ width: `${pct}%` }} />
      </div>
      <Link
        href={`/projects/${projectId}/requirements`}
        className="btn btn-primary"
        style={{ justifyContent: "center", padding: "7px 0", fontSize: 11.5 }}
      >
        Requirements
      </Link>
    </div>
  );
}

// ---------- topbar ----------

const SEGMENT_LABELS: Record<string, string> = {
  projects: "Projects",
  requirements: "Requirements",
  runs: "Runs",
  reports: "Reports",
  members: "Members",
  audit: "Audit log",
};

function Topbar({
  project,
  projectId,
  initials,
  onOpenPalette,
}: {
  project: ShellProject | null;
  projectId: string | null;
  initials: string;
  onOpenPalette: () => void;
}) {
  const pathname = usePathname() ?? "";
  const parts = pathname.split("/").filter(Boolean);

  let rootLabel = "Workspace";
  let rootHref = "/projects";
  let current = "Projects";

  if (projectId) {
    rootLabel = project?.name ?? "Project";
    rootHref = `/projects/${projectId}`;
    const rest = parts.slice(2); // after ["projects", id]
    if (rest.length === 0) current = "Overview";
    else if (rest[0] === "runs" && rest[1]) current = `Run ${rest[1].slice(0, 8)}`;
    else current = SEGMENT_LABELS[rest[0]] ?? rest[0];
  } else if (parts[0] === "settings") {
    current = SEGMENT_LABELS[parts[1] ?? ""] ?? "Settings";
  }

  return (
    <header className="topbar" data-testid="nav-topbar">
      <div className="crumb">
        <Link href={rootHref} className="crumb-link" title={rootLabel}>
          {rootLabel}
        </Link>
        <span className="crumb-sep">/</span>
        <span className="crumb-current">{current}</span>
      </div>

      <button type="button" className="search" onClick={onOpenPalette} data-testid="nav-search">
        Search projects and pages…
        <span className="search-key">⌘K</span>
      </button>

      {/* The design puts a primary CTA here. It is a project-scoped action, so
          outside a project the slot stays empty rather than offering a button
          that would navigate to the page you are already on. */}
      {projectId && (
        <Link
          href={`/projects/${projectId}/runs`}
          className="btn btn-primary"
          data-testid="nav-new-run"
        >
          ▶ New run
        </Link>
      )}

      <span className="avatar" aria-hidden>
        {initials}
      </span>
    </header>
  );
}

// ---------- command palette (the design's ⌘K search, made real) ----------

type PaletteEntry = { label: string; hint: string; href: string };

function CommandPalette({
  open,
  onClose,
  projectId,
  projects,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string | null;
  projects: ShellProject[];
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);

  const entries = useMemo<PaletteEntry[]>(() => {
    const out: PaletteEntry[] = projects.map((p) => ({
      label: p.name,
      hint: "Project",
      href: `/projects/${p.id}`,
    }));
    if (projectId) {
      for (const g of projectNav(`/projects/${projectId}`)) {
        for (const it of g.items) out.push({ label: it.label, hint: g.label, href: it.href });
      }
    }
    out.push({ label: "All projects", hint: "Workspace", href: "/projects" });
    out.push({ label: "Members", hint: "Account", href: "/settings/members" });
    out.push({ label: "Audit log", hint: "Account", href: "/settings/audit" });
    return out;
  }, [projects, projectId]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? entries.filter((e) => `${e.label} ${e.hint}`.toLowerCase().includes(needle))
      : entries;
    return list.slice(0, 12);
  }, [entries, q]);

  useEffect(() => {
    if (open) {
      setQ("");
      setCursor(0);
    }
  }, [open]);

  useEffect(() => {
    if (cursor > results.length - 1) setCursor(0);
  }, [results.length, cursor]);

  if (!open) return null;

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        data-testid="nav-palette"
        style={{ maxWidth: 520 }}
      >
        <div style={{ padding: "16px 18px 0" }}>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input
            className="input"
            autoFocus
            placeholder="Search projects and pages…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, results.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              }
              if (e.key === "Enter" && results[cursor]) go(results[cursor].href);
            }}
            aria-label="Search projects and pages"
          />
        </div>
        <div className="modal-body" style={{ paddingTop: 12 }}>
          {results.length === 0 ? (
            <div className="empty-hint" style={{ padding: "8px 2px" }}>
              Nothing matches “{q}”.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {results.map((r, i) => (
                <button
                  key={`${r.href}-${i}`}
                  type="button"
                  className="nav-item"
                  style={{
                    width: "100%",
                    border: 0,
                    cursor: "pointer",
                    background: i === cursor ? "var(--blueS)" : "transparent",
                    color: i === cursor ? "var(--blue)" : "var(--text-secondary)",
                  }}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => go(r.href)}
                >
                  {r.label}
                  <span style={{ marginInlineStart: "auto", fontSize: 10, color: "var(--text-muted)" }}>
                    {r.hint}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- shell ----------

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const [project, setProject] = useState<ShellProject | null>(null);
  const [projects, setProjects] = useState<ShellProject[]>([]);
  const [user, setUserState] = useState<any>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const match = pathname.match(/^\/projects\/([^/]+)/);
  const projectId = match ? match[1] : null;

  // drop a stale project the moment the route leaves it, so the breadcrumb
  // never names the project you just navigated away from
  useEffect(() => {
    if (!projectId) setProject(null);
    else setProject((p) => (p && p.id !== projectId ? null : p));
  }, [projectId]);

  useEffect(() => {
    const read = () => setUserState(getUser());
    read();
    window.addEventListener("traceo-auth", read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener("traceo-auth", read);
      window.removeEventListener("storage", read);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api<any>("/projects");
        const list = Array.isArray(res) ? res : res?.items ?? [];
        if (alive) setProjects(list);
      } catch {
        /* the projects page surfaces its own error */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const initials = String(user?.name ?? user?.email ?? "T")
    .trim()
    .charAt(0)
    .toUpperCase();

  const ctx = useMemo<ShellCtx>(() => ({ project, setProject }), [project]);

  return (
    <Ctx.Provider value={ctx}>
      <div className="app-shell" data-testid={projectId ? "nav-project-shell" : undefined}>
        <Rail projectId={projectId} initials={initials} />
        <Sidebar project={project} projectId={projectId} projectCount={projects.length} />
        <div className="shell-main">
          <Topbar
            project={project}
            projectId={projectId}
            initials={initials}
            onOpenPalette={() => setPaletteOpen(true)}
          />
          <main className="content">{children}</main>
        </div>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        projectId={projectId}
        projects={projects}
      />
    </Ctx.Provider>
  );
}
