"use client";

import { useSyncExternalStore } from "react";
import { getUser } from "@/lib/api";

/**
 * Role capability map — transcribed 1:1 from `backend/app/security.py`
 * (PERMISSIONS, SRS §4.10). The backend is the source of truth; this copy
 * only powers UI defense-in-depth (hiding controls the server would 403).
 */
export type Role = "admin" | "qa_lead" | "qa_engineer" | "viewer";

export type Capability =
  | "manage_members"
  | "manage_projects"
  | "manage_environments"
  | "upload_documents"
  | "edit_requirements"
  | "import_spec"
  | "generate"
  | "edit_test_case"
  | "approve_reject"
  | "trigger_run"
  | "view"
  | "export"
  | "view_audit_log";

export const ROLES: readonly Role[] = ["admin", "qa_lead", "qa_engineer", "viewer"];

export const PERMISSIONS: Record<Capability, readonly Role[]> = {
  manage_members: ["admin"],
  manage_projects: ["admin", "qa_lead"],
  manage_environments: ["admin", "qa_lead"],
  upload_documents: ["admin", "qa_lead", "qa_engineer"],
  edit_requirements: ["admin", "qa_lead", "qa_engineer"],
  import_spec: ["admin", "qa_lead", "qa_engineer"],
  generate: ["admin", "qa_lead", "qa_engineer"],
  edit_test_case: ["admin", "qa_lead", "qa_engineer"],
  approve_reject: ["admin", "qa_lead"],
  trigger_run: ["admin", "qa_lead", "qa_engineer"],
  view: ["admin", "qa_lead", "qa_engineer", "viewer"],
  export: ["admin", "qa_lead", "qa_engineer", "viewer"],
  view_audit_log: ["admin", "qa_lead"],
};

/** Mirrors backend `has_permission(role, capability)`. Unknown role/capability → false. */
export function can(role: string | null | undefined, capability: Capability): boolean {
  if (!role) return false;
  const allowed = PERMISSIONS[capability];
  return !!allowed && (allowed as readonly string[]).includes(role);
}

// ---- module-level store, kept in sync via the existing 'traceo-auth' event ----

function readRole(): string | null {
  const u = getUser();
  const role = u && typeof u === "object" ? u.role : null;
  return typeof role === "string" ? role : null;
}

let currentRole: string | null = readRole();

function subscribe(fn: () => void): () => void {
  const handler = () => {
    currentRole = readRole();
    fn();
  };
  window.addEventListener("traceo-auth", handler);
  // localStorage writes from other tabs fire 'storage', not 'traceo-auth'
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener("traceo-auth", handler);
    window.removeEventListener("storage", handler);
  };
}

function getSnapshot(): string | null {
  return currentRole;
}

function getServerSnapshot(): string | null {
  return null;
}

/** Current user's role from the cached `traceo_user` profile (SSR-safe; null when logged out). */
export function useRole(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** `can()` bound to the current user's role, reactive to auth changes. */
export function useCan(): (capability: Capability) => boolean {
  const role = useRole();
  return (capability: Capability) => can(role, capability);
}
