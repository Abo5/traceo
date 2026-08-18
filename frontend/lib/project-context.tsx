"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { api } from "@/lib/api";

export type ProjectInfo = {
  id: string;
  name: string;
  automation?: "auto" | "manual" | string;
  /**
   * Which of the five kinds of testing this project is for. An empty or absent
   * list means "nothing was said", which every reader treats as all five — see
   * lib/test-types.ts::projectTestTypes.
   */
  test_types?: string[] | null;
  status: string;
  created_at?: string | null;
  updated_at?: string | null;
} & Record<string, any>;

type ProjectCtx = {
  project: ProjectInfo | null;
  refresh: () => Promise<void>;
};

const Ctx = createContext<ProjectCtx>({
  project: null,
  refresh: async () => {},
});

export function ProjectProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactNode;
}) {
  const [project, setProject] = useState<ProjectInfo | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const p = await api<ProjectInfo>(`/projects/${projectId}`);
      setProject(p);
    } catch {
      /* keep the last known project — pages surface their own errors */
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return <Ctx.Provider value={{ project, refresh }}>{children}</Ctx.Provider>;
}

export function useProject(): ProjectCtx {
  return useContext(Ctx);
}
