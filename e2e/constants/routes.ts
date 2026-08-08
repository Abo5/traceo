/** Frontend route paths — mirrors frontend/app (Next.js App Router). */

export const routes = {
  home: '/',
  login: '/login',
  register: '/register',
  projects: '/projects',
  settings: '/settings',
  settingsMembers: '/settings/members',

  project: (projectId: string) => `/projects/${projectId}`,
  requirements: (projectId: string) => `/projects/${projectId}/requirements`,
  endpoints: (projectId: string) => `/projects/${projectId}/endpoints`,
  environments: (projectId: string) => `/projects/${projectId}/environments`,
  generate: (projectId: string) => `/projects/${projectId}/generate`,
  review: (projectId: string) => `/projects/${projectId}/review`,
  runs: (projectId: string) => `/projects/${projectId}/runs`,
  run: (projectId: string, runId: string) => `/projects/${projectId}/runs/${runId}`,
  matrix: (projectId: string) => `/projects/${projectId}/matrix`,
  integrations: (projectId: string) => `/projects/${projectId}/integrations`,
  reference: (projectId: string) => `/projects/${projectId}/reference`,
  projectSettings: (projectId: string) => `/projects/${projectId}/settings`,
} as const;
