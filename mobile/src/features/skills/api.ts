/**
 * Skills endpoints.
 *
 * Paths are the FULL client-visible ones. This router is one of the few that
 * really is under `/api` — server/index.js mounts it as
 * `app.use('/api/skills', requireCapability('skills'), …)`, unlike the AI and
 * agent routers next to it. Check the mount line, never the router's own
 * header comment, which still claims a beta gate that moved.
 *
 * `requireCapability('skills')` answers 403 when the workspace's plan does not
 * include Skills at all, and a 503 with `Retry-After: 1` while entitlements are
 * momentarily unresolvable. The client's default retry is exactly right for
 * both: it never retries a 403 (so the screen shows describeError's "not
 * available on your plan" immediately) and it does retry the 503, which is the
 * one the server is asking us to come back for.
 */

import type { Skill, SkillDraft } from './types';
import { api } from '../../api/client';

export const skillKeys = {
    all: ['skills'] as const,
    list: ['skills', 'list'] as const,
    detail: (id: string) => ['skills', 'detail', id] as const,
};

export async function listSkills(signal?: AbortSignal): Promise<Skill[]> {
    return (await api.get<Skill[]>('/api/skills', { signal })) ?? [];
}

export async function getSkill(id: string, signal?: AbortSignal): Promise<Skill | null> {
    return api.get<Skill>(`/api/skills/${encodeURIComponent(id)}`, { signal });
}

/** Answers 201 with the created row. Requires the `manage_skills` permission. */
export async function createSkill(draft: SkillDraft): Promise<Skill | null> {
    return api.post<Skill>('/api/skills', draft);
}

/**
 * Owner-only, and additionally gated on `manage_skills`. An omitted field is
 * left as-is by skillStore.updateSkill, so callers may send a partial patch.
 * The route answers `{ success: true }` rather than the updated row — refetch
 * rather than trying to reconcile locally.
 */
export async function updateSkill(id: string, patch: Partial<SkillDraft>): Promise<void> {
    await api.put(`/api/skills/${encodeURIComponent(id)}`, patch);
}

/**
 * Owner-or-admin. The server also scrubs the id out of every agent in the org
 * that had the skill attached, so a delete is genuinely a delete and no agent
 * is left pointing at nothing.
 */
export async function deleteSkill(id: string): Promise<void> {
    await api.delete(`/api/skills/${encodeURIComponent(id)}`);
}

/**
 * May this session edit `skill`?
 *
 * The server's verdict, not a second opinion. routes/skills.js attaches
 * `canEdit` to every list and detail row (and `true` to a POST result) from
 * the same rule PUT enforces — owner, OR `manage_skills` in the skill's OWN
 * org (server/stores/skillStore.js canEditSkill). Recomputing that here is how
 * an editor drifts from the endpoint it saves to: the old local rule pinned
 * the row to its creator, so a manager who may edit a colleague's shared skill
 * was shown a read-only screen. Track Z's promise is kept — the rule now lives
 * in one place.
 *
 * FAIL-CLOSED on purpose: `=== true`, never `!== false`. A server older than
 * Track S1 sends no `canEdit` at all, and an unknown verdict must narrow to
 * read-only rather than paint an Edit button that ends in a 403.
 */
export function canEditSkill(skill: Skill): boolean {
    return skill.canEdit === true;
}

/**
 * Deleting is owner-or-admin, and does NOT require `manage_skills`. Still a
 * local rule because DELETE has no server verdict on the row to read — the
 * route decides at call time and there is no `canDelete` field to mirror.
 */
export function canDeleteSkill(skill: Skill, userId: string | undefined, isAdmin: boolean): boolean {
    return isAdmin || (Boolean(userId) && skill.userId === userId);
}
