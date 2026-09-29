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
 *
 * Skills are Enterprise. That 403's body is `{ error: 'feature_locked', … }`:
 * a CODE where the client looks for a sentence (src/api/client.ts takes
 * `error` as the message), so the plan screen would read "feature_locked".
 * `readableRefusal` below swaps the code for words before the screen sees it.
 * The one route that never asks for Skills is DELETE /:id: removing a skill
 * works on every plan (server/core/skills/creationGate.js exceptRemoval).
 */

import type { Skill, SkillDraft } from './types';
import { ApiError, api } from '../../api/client';
import { translate } from '../../i18n';

/** The two answers the capability gate writes into `error` as bare codes. */
const ENTITLEMENT_CODES = new Set(['feature_locked', 'feature_disabled']);

/**
 * A 403 whose `error` is an entitlement CODE, rewritten as a sentence; any
 * other error comes back untouched. A refusal that already carries a sentence
 * (`not_editable`, or the server's own "Adding skills needs Skills…" from the
 * wizard and the chat import, which put the code in `code`) is left alone,
 * because the server's words are better than ours.
 */
export function readableRefusal(error: unknown): unknown {
    if (!(error instanceof ApiError) || error.status !== 403) return error;
    const body = error.body as { error?: unknown } | null | undefined;
    const code = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : '';
    if (!ENTITLEMENT_CODES.has(code)) return error;
    const message = code === 'feature_locked'
        ? translate(
            'mobile.skills.plan_locked',
            'Skills are part of the Enterprise plan. Ask an administrator if you need them.',
        )
        : translate(
            'mobile.skills.plan_disabled',
            'Skills are not switched on for you. Ask an administrator if you need them.',
        );
    return new ApiError(message, { status: error.status, body: error.body });
}

async function readable<T>(call: Promise<T>): Promise<T> {
    try {
        return await call;
    } catch (error) {
        throw readableRefusal(error);
    }
}

export const skillKeys = {
    all: ['skills'] as const,
    list: ['skills', 'list'] as const,
    detail: (id: string) => ['skills', 'detail', id] as const,
};

export async function listSkills(signal?: AbortSignal): Promise<Skill[]> {
    return (await readable(api.get<Skill[]>('/api/skills', { signal }))) ?? [];
}

export async function getSkill(id: string, signal?: AbortSignal): Promise<Skill | null> {
    return readable(api.get<Skill>(`/api/skills/${encodeURIComponent(id)}`, { signal }));
}

/** Answers 201 with the created row. Requires the `manage_skills` permission. */
export async function createSkill(draft: SkillDraft): Promise<Skill | null> {
    return readable(api.post<Skill>('/api/skills', draft));
}

/**
 * Owner-only, and additionally gated on `manage_skills`. An omitted field is
 * left as-is by skillStore.updateSkill, so callers may send a partial patch.
 * The route answers `{ success: true }` rather than the updated row — refetch
 * rather than trying to reconcile locally.
 */
export async function updateSkill(id: string, patch: Partial<SkillDraft>): Promise<void> {
    await readable(api.put(`/api/skills/${encodeURIComponent(id)}`, patch));
}

/**
 * Owner-or-admin. The server also scrubs the id out of every agent in the org
 * that had the skill attached, so a delete is genuinely a delete and no agent
 * is left pointing at nothing. Never plan-gated: an organisation whose plan
 * lost Skills can still remove what it made.
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
