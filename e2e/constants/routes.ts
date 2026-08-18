/** Frontend route paths — mirrors frontend/app (Next.js App Router). */

export const routes = {
  home: '/',
  // Deliberately absent from frontend/app: this build has no sign-in screen.
  // They are kept here as the addresses tests/auth.spec.ts proves do not
  // resolve — deleting the constants would delete the guard with them.
  login: '/login',
  register: '/register',
  projects: '/projects',
  /** Latest report per project — workspace-scoped, see frontend/app/reports. */
  reports: '/reports',
  settings: '/settings',
  settingsMembers: '/settings/members',

  project: (projectId: string) => `/projects/${projectId}`,
  requirements: (projectId: string) => `/projects/${projectId}/requirements`,
  runs: (projectId: string) => `/projects/${projectId}/runs`,
  /** This project's reports — the workspace-level `reports` lists all projects. */
  projectReports: (projectId: string) => `/projects/${projectId}/reports`,
  run: (projectId: string, runId: string) => `/projects/${projectId}/runs/${runId}`,
} as const;
