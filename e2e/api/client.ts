/**
 * ApiClient — one Repository per backend module (§11), bound to an actor of the
 * run org provisioned by global/auth.setup.ts. Specs and journeys go through
 * repositories; raw `request` never leaves this layer.
 */
import * as fs from 'node:fs';
import { request, type APIRequestContext } from '@playwright/test';
import { config } from '../config/resolve';
import type { Role } from '../constants/roles';
import { ACTORS_FILE } from '../helpers/paths';
import type { OrgActor, WorkerOrg } from './auth.helpers';
import { DiscoveryRepository } from './discovery.repository';
import { RunsRepository } from './execution.repository';
import { GenerationRepository } from './generation.repository';
import { TraceoHttp } from './http';
import { IdentityRepository } from './identity.repository';
import { IngestionRepository } from './ingestion.repository';
import { JobPoller } from './job-poller';
import { ProjectsRepository } from './projects.repository';
import { ReviewRepository } from './review.repository';

export class ApiClient {
  readonly http: TraceoHttp;
  readonly jobs: JobPoller;
  readonly identity: IdentityRepository;
  readonly projects: ProjectsRepository;
  readonly ingestion: IngestionRepository;
  readonly discovery: DiscoveryRepository;
  readonly generation: GenerationRepository;
  readonly review: ReviewRepository;
  readonly runs: RunsRepository;

  private constructor(
    private readonly ctx: APIRequestContext,
    private readonly actors: ReadonlyMap<Role, OrgActor>,
    /** The actor this client acts as. */
    readonly role: Role,
    /** True only for the root client — `.as()` clones share the context. */
    private readonly ownsContext: boolean,
  ) {
    this.http = new TraceoHttp(ctx, config.apiUrl, {
      kind: 'bearer',
      token: this.actor().token,
    });
    this.jobs = new JobPoller(this.http);
    this.identity = new IdentityRepository(this.http);
    this.projects = new ProjectsRepository(this.http);
    this.ingestion = new IngestionRepository(this.http, this.jobs);
    this.discovery = new DiscoveryRepository(this.http);
    this.generation = new GenerationRepository(this.http, this.jobs);
    this.review = new ReviewRepository(this.http);
    this.runs = new RunsRepository(this.http, this.jobs);
  }

  /**
   * Client for the run org registered by the setup project (§9). Defaults to
   * qa_engineer — the fast setup path; escalate per call via `.as('qa_lead')`.
   */
  static async forWorkerOrg(role: Role = 'qa_engineer'): Promise<ApiClient> {
    if (!fs.existsSync(ACTORS_FILE)) {
      throw new Error(
        `${ACTORS_FILE} not found — the 'setup' project (global/auth.setup.ts) must run first.`,
      );
    }
    const org = JSON.parse(fs.readFileSync(ACTORS_FILE, 'utf8')) as WorkerOrg;
    const ctx = await request.newContext();
    return new ApiClient(ctx, new Map(org.actors.map((a) => [a.role, a])), role, true);
  }

  /** Same org and context, different actor (auth Strategy switch). */
  as(role: Role): ApiClient {
    if (role === this.role) return this;
    return new ApiClient(this.ctx, this.actors, role, false);
  }

  actor(role: Role = this.role): OrgActor {
    const actor = this.actors.get(role);
    if (!actor) throw new Error(`No provisioned actor for role '${role}'`);
    return actor;
  }

  /** Dispose the shared request context — call on the root client only. */
  async dispose(): Promise<void> {
    if (this.ownsContext) await this.ctx.dispose();
  }
}
