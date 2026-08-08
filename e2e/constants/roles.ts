/** The four roles — single source of truth: backend/app/security.py ROLES. */
export const ROLES = ['admin', 'qa_lead', 'qa_engineer', 'viewer'] as const;

export type Role = (typeof ROLES)[number];
