/**
 * Skills endpoints.
 *
 * This router really is under `/api` — server/index.js mounts it as
 * `app.use('/api/skills', requireCapability('skills'), …)`. That gate answers
 * 403 when the plan has no Skills and 503 + Retry-After while entitlements are
 * momentarily unresolvable; the client's default retry is right for both.
 *
 * Writes send the STRUCTURE (model/skillModel buildSavePayload), never the
 * text columns — see model/types.
 */

import { api } from '@/core/api/client';
import { guardedDelete } from '@/core/api/deleteGuard';
import { readUsageAnswer, type UsageAnswer } from '@/core/api/usage';

import { readImproved, readProposal, readSkillOrNull, readSkills, readUsageSummary } from './readers';
import type { Skill, SkillDraft, SkillProposal, UsageSummary } from '../model/types';

export const skillPath = (id: string) => `/api/skills/${encodeURIComponent(id)}`;

export async function listSkills(signal?: AbortSignal): Promise<Skill[]> {
    return readSkills(await api.get<unknown>('/api/skills', { signal }));
}

export async function getSkill(id: string, signal?: AbortSignal): Promise<Skill | null> {
    return readSkillOrNull(await api.get<unknown>(skillPath(id), { signal }));
}

/** `{ summary: { [skillId]: { agents, automations, lastUsedAt } } }`. */
export async function getSkillUsageSummary(signal?: AbortSignal): Promise<UsageSummary> {
    return readUsageSummary(await api.get<unknown>('/api/skills/usage-summary', { signal }));
}

/** `{ usage, unchecked }` — agents that attach it, AI steps that apply it. */
export async function getSkillUsage(id: string, signal?: AbortSignal): Promise<UsageAnswer> {
    return readUsageAnswer(await api.get<unknown>(`${skillPath(id)}/usage`, { signal }));
}

/** 201 with the created row. Requires `manage_skills`. */
export async function createSkill(draft: Partial<SkillDraft> & { name: string }): Promise<Skill | null> {
    return readSkillOrNull(await api.post<unknown>('/api/skills', draft));
}

/**
 * Owner OR `manage_skills` in the skill's own org; 403 `not_editable` for a
 * skill that is visible but not editable, which the autosave treats as a stop
 * rather than a retry. Answers `{ success: true }` — refetch for the row.
 */
export async function updateSkill(id: string, payload: Partial<SkillDraft>): Promise<void> {
    await api.put(skillPath(id), payload);
}

/**
 * Owner-or-admin. While an agent or an automation step still uses the skill, the
 * first DELETE is refused with `409 in_use`; `confirmedBreaking` — sent only
 * after that list was shown — becomes `?confirmBreaking=true`.
 */
export async function deleteSkill(id: string, opts: { confirmedBreaking?: boolean } = {}): Promise<void> {
    await guardedDelete(skillPath(id), 'skill', opts.confirmedBreaking);
}

/**
 * "Let AI fill it in": one sentence → a whole skill. NOT stored. A model call,
 * so no retry (a retry would bill twice) and a long timeout. null when the
 * model's answer was not a skill.
 */
export async function draftSkill(sentence: string): Promise<SkillProposal | null> {
    const res = await api.post<unknown>('/api/skills/ai/draft', { sentence }, { retry: false, timeoutMs: 90_000 });
    return readProposal(res);
}

/** "Improve with AI": the server rewrites AND persists, and answers with the stored row. */
export async function improveSkill(id: string, note = ''): Promise<Skill | null> {
    const res = await api.post<unknown>(`${skillPath(id)}/ai/improve`, { note }, { retry: false, timeoutMs: 90_000 });
    return readImproved(res);
}
