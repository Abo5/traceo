"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Badge, Button, Card, Empty, Input, PageHeader, Pill, RefChip } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";

type Feature = {
  id: string;
  group: string;
  name?: string;
  name_en?: string;
  priority: "P0" | "P1" | "P2" | string;
  status: "built" | "planned" | string;
  description?: string;
  description_en?: string;
};

const featureName = (f: Feature): string => f.name_en || f.name || f.id;
const featureDescription = (f: Feature): string => f.description_en || f.description || "";

function asList(x: any): Feature[] {
  if (Array.isArray(x)) return x;
  return x?.items ?? x?.features ?? [];
}

const PRIORITY_TONE: Record<string, BadgeTone> = {
  P0: "error",
  P1: "warning",
  P2: "muted",
};

const GROUP_LABELS: Record<string, string> = {
  parser: "Parser",
  discovery: "Discovery",
  generator: "Generator",
  execution: "Execution",
  reporting: "Reporting",
  automation: "Automation",
  integrations: "Integrations",
  platform: "Platform",
};

const groupLabel = (g: string): string => GROUP_LABELS[g] ?? g;

export default function ReferencePage() {
  const L = {
    title: "Reference",
    sub: "Feature catalog — every capability carries a stable ID shown in the UI and the spec",
    loading: "Loading…",
    retry: "Retry",
    loadError: "Failed to load the catalog",
    search: "Search features…",
    all: "All",
    built: "Built",
    planned: "Planned",
    features: "features",
    groups: "groups",
    empty: "No results",
    emptyHint: "Try a different search term or filter",
  };

  const [features, setFeatures] = useState<Feature[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [group, setGroup] = useState<string>("");
  const [priority, setPriority] = useState<string>("");

  function load() {
    setLoading(true);
    setError(null);
    api(`/reference/features`)
      .then((r) => setFeatures(asList(r)))
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  const groups = useMemo(() => {
    const seen: string[] = [];
    for (const f of features) if (f.group && !seen.includes(f.group)) seen.push(f.group);
    return seen;
  }, [features]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return features.filter((f) => {
      if (group && f.group !== group) return false;
      if (priority && f.priority !== priority) return false;
      if (term) {
        const hay = `${f.id} ${featureName(f)} ${featureDescription(f)} ${f.group}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [features, q, group, priority]);

  const builtCount = features.filter((f) => f.status === "built").length;
  const plannedCount = features.filter((f) => f.status === "planned").length;
  const p0Count = features.filter((f) => f.priority === "P0").length;

  return (
    <div className="stack" data-testid="reference-page-root">
      <PageHeader title={L.title} sub={L.sub} testId="reference-page-header" />

      {loading ? (
        <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>{L.loading}</div>
      ) : error ? (
        <div className="row" style={{ gap: 10 }}>
          <span className="error-text" style={{ fontSize: 13 }}>
            {L.loadError} — {error}
          </span>
          <Button variant="secondary" size="sm" onClick={load} testId="reference-retry-button">
            {L.retry}
          </Button>
        </div>
      ) : (
        <>
          {/* counts summary */}
          <div className="mono" style={{ fontSize: 12, color: "var(--text-secondary)", textAlign: "left" }}>
            <span style={{ color: "var(--text)" }}>{features.length}</span> {L.features} ·{" "}
            <span style={{ color: "var(--success)" }}>{builtCount}</span> {L.built} ·{" "}
            <span style={{ color: "var(--text-secondary)" }}>{plannedCount}</span> {L.planned} ·{" "}
            <span style={{ color: "var(--error)" }}>{p0Count}</span> P0 ·{" "}
            <span style={{ color: "var(--text-secondary)" }}>{groups.length}</span> {L.groups}
          </div>

          {/* filters */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ width: 260 }}>
              <Input placeholder={L.search} value={q} onChange={(e) => setQ(e.target.value)} testId="reference-search-input" />
            </div>
            <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
              <Pill active={group === ""} onClick={() => setGroup("")} testId="reference-group-all-pill">
                {L.all}
              </Pill>
              {groups.map((g) => (
                <Pill key={g} active={group === g} onClick={() => setGroup(group === g ? "" : g)} testId={`reference-group-${g}-pill`}>
                  {groupLabel(g)}
                </Pill>
              ))}
            </div>
            <div className="row" style={{ gap: 4 }}>
              {["P0", "P1", "P2"].map((p) => (
                <Pill key={p} active={priority === p} onClick={() => setPriority(priority === p ? "" : p)} testId={`reference-priority-${p.toLowerCase()}-pill`}>
                  <span className="mono" style={{ fontSize: 11.5 }}>
                    {p}
                  </span>
                </Pill>
              ))}
            </div>
          </div>

          {/* rows */}
          {filtered.length === 0 ? (
            <Empty title={L.empty} hint={L.emptyHint} testId="reference-empty-state" />
          ) : (
            <Card pad={false} testId="reference-list-card">
              {filtered.map((f, i) => (
                <div
                  key={f.id}
                  data-testid="reference-feature-row"
                  data-state={f.status}
                  style={{
                    display: "flex",
                    gap: 14,
                    alignItems: "flex-start",
                    padding: "12px 18px",
                    borderTop: i === 0 ? "none" : "1px solid var(--border)",
                  }}
                >
                  <div style={{ paddingTop: 2, flexShrink: 0 }}>
                    <RefChip id={f.id} testId="reference-feature-refchip" />
                  </div>
                  <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>
                        {featureName(f)}
                      </span>
                      <Badge tone="muted">{groupLabel(f.group)}</Badge>
                      <Badge tone={PRIORITY_TONE[f.priority] ?? "muted"}>
                        <span className="mono" style={{ fontSize: 10.5 }}>
                          {f.priority}
                        </span>
                      </Badge>
                      <Badge tone={f.status === "built" ? "success" : "muted"} testId="reference-feature-status-badge" state={f.status}>
                        {f.status === "built" ? L.built : L.planned}
                      </Badge>
                    </div>
                    {featureDescription(f) && (
                      <div style={{ fontSize: 12.5, lineHeight: 1.6, color: "var(--text-secondary)" }}>
                        {featureDescription(f)}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
