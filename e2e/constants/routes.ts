/** Frontend route paths — mirrors frontend/app (Next.js App Router). */

export const routes = {
  home: '/',
  // Deliberately absent from frontend/app: this build has no sign-in screen.
  // They are kept here as the addresses tests/auth.spec.ts proves do not
  // resolve — deleting the constants would delete the guard with them.
  login: '/login',
  register: '/register',
  projects: '/projects',
  settings: '/settings',
  settingsMembers: '/settings/members',

  project: (projectId: string) => `/projects/${projectId}`,
  requirements: (projectId: string) => `/projects/${projectId}/requirements`,
  /** Web target — point Traceo at a URL, pick test types, read the design box. */
  target: (projectId: string) => `/projects/${projectId}/target`,
  endpoints: (projectId: string) => `/projects/${projectId}/endpoints`,
  environments: (projectId: string) => `/projects/${projectId}/environments`,
  generate: (projectId: string) => `/projects/${projectId}/generate`,
  insights: (projectId: string) => `/projects/${projectId}/insights`,
  review: (projectId: string) => `/projects/${projectId}/review`,
  runs: (projectId: string) => `/projects/${projectId}/runs`,
  run: (projectId: string, runId: string) => `/projects/${projectId}/runs/${runId}`,
  matrix: (projectId: string) => `/projects/${projectId}/matrix`,
  integrations: (projectId: string) => `/projects/${projectId}/integrations`,
  reference: (projectId: string) => `/projects/${projectId}/reference`,
  projectSettings: (projectId: string) => `/projects/${projectId}/settings`,
} as const;
