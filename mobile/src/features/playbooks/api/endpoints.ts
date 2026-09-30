/**
 * The playbook endpoints (server/routes/playbooks/, mounted at
 * /api/playbooks), plus the three owner-only App Studio calls the access
 * phase applies its plan through.
 *
 * Every write carries `expectedVersion`; a 409 `version_conflict` comes back
 * with the current playbook in its body, and the caller adopts it rather than
 * retrying blindly (see hooks/usePlaybookActions.ts). Writes never retry.
 */

import { api } from '@/core/api/client';
import { field, pick } from '@/core/api/contract';
import { translate } from '@/core/i18n';

import { readAccessPlan, readAppAccess, readPlaybook, readPlaybookList, readRecipe, readTableChoices } from './readers';
import type { Wire } from '../model/phaseMachine';
import type { AccessPlan, AppAccess, ComposeResult, Playbook, PlaybookSummary, RegisterResult, TableChoice } from '../model/types';

const BASE = '/api/playbooks';
const one = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
const phase = (id: string, key: string) => `${one(id)}/phases/${encodeURIComponent(key)}`;
const WRITE = { retry: false as const };
// A server-run phase answers when it is done (a design is one model call, up
// to 90s); the client must not give up first.
const RUN = { retry: false as const, timeoutMs: 120_000 };

export async function listPlaybooks(signal?: AbortSignal): Promise<PlaybookSummary[]> {
    return readPlaybookList(await api.get<unknown>(BASE, { signal }));
}

/** Throws on a body without a playbook: the screen shows that as its error, with a retry. */
export async function getPlaybook(id: string, signal?: AbortSignal): Promise<Playbook> {
    const pb = readPlaybook(await api.get<unknown>(one(id), { signal }));
    if (!pb) throw new Error(translate('playbooks.err_load', 'Could not load this playbook'));
    return pb;
}

/** The AI writes a recipe document from a description. Stores nothing. */
export async function composeRecipe(description: string, locale: string): Promise<ComposeResult | null> {
    const res = await api.post<unknown>(`${BASE}/recipes/compose`, { description, locale }, RUN);
    const recipe = readRecipe(pick(res, 'recipe'));
    return recipe ? { recipe, warnings: field.strArray(pick(res, 'warnings')) } : null;
}

/**
 * The model tiers this person may pin a playbook to — the same permission-
 * and task-aware list both builders read, for the 'automation' task. Only
 * which tiers have a model behind them matters here.
 */
export async function listTierModels(signal?: AbortSignal): Promise<Record<string, { modelId?: string }>> {
    const res = await api.get<unknown>('/ai/config/tiers-for-user', { query: { taskType: 'automation' }, signal });
    const out: Record<string, { modelId?: string }> = {};
    if (res && typeof res === 'object' && !Array.isArray(res)) {
        for (const [key, value] of Object.entries(res)) out[key] = { modelId: field.optStr(pick(value, 'modelId')) };
    }
    return out;
}

/** The tables an "existing table" playbook may fill; its columns are checked in the first phase. */
export async function listTables(signal?: AbortSignal): Promise<TableChoice[]> {
    return readTableChoices(await api.get<unknown>('/api/datatables', { signal }));
}

export async function createPlaybook(body: Record<string, unknown>): Promise<Playbook | null> {
    return readPlaybook(await api.post<unknown>(BASE, body, WRITE));
}

export async function deletePlaybook(id: string): Promise<void> {
    await api.delete<unknown>(one(id), WRITE);
}

/** One wire (model/phaseMachine patchFor) sent: a PATCH of the entity or a POST to a phase route. */
export async function sendWire(id: string, wire: Wire): Promise<Playbook | null> {
    const res = wire.method === 'PATCH'
        ? await api.patch<unknown>(one(id), wire.body, WRITE)
        : await api.post<unknown>(`${one(id)}/${wire.route}`, wire.body ?? {}, RUN);
    return readPlaybook(res);
}

/** The compliance review read again after a fix (the web's "Check again"). */
export async function recheckCompliance(id: string, key: string): Promise<Playbook | null> {
    return readPlaybook(await api.post<unknown>(`${phase(id, key)}/run`, { recheck: true }, RUN));
}

/** The access assistant: a sentence in, a PROPOSAL out. Writes nothing. */
export async function proposeAccess(id: string, key: string, message: string): Promise<AccessPlan | null> {
    const res = await api.post<unknown>(`${phase(id, key)}/access-plan`, { message }, RUN);
    const plan = pick(res, 'plan');
    return plan && typeof plan === 'object' ? readAccessPlan(plan) : null;
}

/** The compliance phase's ONE write: the table's registration, the kept risks, the review as evidence. */
export async function registerCompliance(id: string, key: string, body: Record<string, unknown>): Promise<RegisterResult> {
    const res = await api.post<unknown>(`${phase(id, key)}/register`, body, WRITE);
    return {
        playbook: readPlaybook(res),
        written: field.strArray(pick(res, 'written')),
        failed: field.list((f) => ({ what: field.str('')(pick(f, 'what')), error: field.strOrNull(pick(f, 'error')) }))(pick(res, 'failed')),
    };
}

// ── The app the access phase governs (routes/studioApps.js, studioAppData.js) ──

const app = (appId: string) => `/api/studio-apps/${encodeURIComponent(appId)}`;

export async function getAppAccess(appId: string, signal?: AbortSignal): Promise<{ app: AppAccess | null; members: number }> {
    const [appRes, membersRes] = await Promise.all([
        api.get<unknown>(app(appId), { signal }),
        api.get<unknown>(`${app(appId)}/members`, { signal }).catch(() => null),
    ]);
    const members = pick(membersRes, 'members');
    return { app: readAppAccess(appRes), members: Array.isArray(members) ? members.length : 0 };
}

export async function assignAppMember(appId: string, userId: string, roleKey: string): Promise<void> {
    await api.post<unknown>(`${app(appId)}/members`, { userId, roleKey }, WRITE);
}

export async function publishApp(appId: string, body: { isPublished: boolean; sharedGroups?: string[] }): Promise<void> {
    await api.patch<unknown>(`${app(appId)}/publish`, body, WRITE);
}
