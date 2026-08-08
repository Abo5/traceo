/**
 * Identity repository — backend/app/modules/identity.py.
 *
 * Verified request/response shapes:
 * - POST /auth/register {org_name, name, email, password, locale?} -> 201 {token, user}
 * - POST /auth/login {email, password} -> 200 {token, user} (user carries org_name)
 * - POST /members/invite {email, name, role, password} -> 201 user payload
 *   (the inviter SETS the member's password — no activation flow; the invitee
 *   can log in immediately with it)
 */
import type { TraceoHttp } from './http';
import type { AuthResponse, AuthUser, InviteBody, RegisterBody } from './types';

export class IdentityRepository {
  constructor(private readonly http: TraceoHttp) {}

  async register(body: RegisterBody): Promise<AuthResponse> {
    return this.http.post<AuthResponse>('/auth/register', body);
  }

  async login(email: string, password: string): Promise<AuthResponse> {
    return this.http.post<AuthResponse>('/auth/login', { email, password });
  }

  async me(): Promise<AuthUser> {
    return this.http.get<AuthUser>('/me');
  }

  /** manage_members (admin only). Returns the created member's user payload. */
  async invite(body: InviteBody): Promise<AuthUser> {
    return this.http.post<AuthUser>('/members/invite', body);
  }

  async members(): Promise<AuthUser[]> {
    return this.http.get<AuthUser[]>('/members');
  }

  async updateMemberRole(memberId: string, role: string): Promise<AuthUser> {
    return this.http.patch<AuthUser>(`/members/${memberId}`, { role });
  }

  async auditLog(limit = 50, cursor?: string): Promise<{
    items: Array<{
      id: string;
      actor_id: string | null;
      action: string;
      object_type: string;
      object_id: string;
      detail: Record<string, unknown>;
      occurred_at: string | null;
    }>;
    next_cursor: string | null;
  }> {
    return this.http.get('/audit', { limit, cursor });
  }
}
