/**
 * service.mts: the one screening entry point the automation tool (integrations/sanctionsTools.mts)
 * and the App Studio step (appStudio/actionExecutor/steps/sanctions_screen.mts) both call, so the
 * access rule and the answer's shape cannot drift between them.
 *
 *   access({ userId, orgId })        licence feature `sanctions_screening` for the organisation
 *                                    (or the user), and the `sanctions-lists` integration
 *                                    switched on for the user (the org admin's switch)
 *   screen({ name, birthDate, country, function, lists, minScore, maxResults })
 *       -> { candidates, pep, lists: [{ id, label, status, lastSuccessAt, entityCount }], checkedAt }
 *
 * PRIVACY: everything runs on this server against the stored public lists. The name being
 * screened never leaves it, is not logged and is not stored: the log line says how many
 * candidates came back, nothing else.
 */

import { createRequire } from 'node:module';
import { nameKeys } from './normalize.mts';
import { screenCandidates, screenOptions, type Candidate } from './screen.mts';
import { checkPepFunction, type PepCheck } from './pepFunctions.mts';
import { LIST_SOURCES } from './sources.mts';
import type { ListStatusRow, SanctionsStore } from '../../stores/sanctionsStore.mts';

const nodeRequire = createRequire(import.meta.url);

export const LICENCE_FEATURE = 'sanctions_screening';
export const INTEGRATION_ID = 'sanctions-lists';
/** Stored names fetched per screening at most; they are scored in memory. */
export const CANDIDATE_LIMIT = 3000;
export const MAX_NAME_CHARS = 300;

export interface ScreenInput {
    name?: unknown;
    birthDate?: unknown;
    country?: unknown;
    function?: unknown;
    lists?: unknown;
    minScore?: unknown;
    maxResults?: unknown;
}

export interface ListInfo { id: string; label: string; status: string; lastSuccessAt: string | null; entityCount: number; stale: boolean; lastError: string | null }

export interface ScreenResult {
    screened: boolean;
    candidates: Candidate[];
    candidateCount: number;
    pep: PepCheck | null;
    lists: ListInfo[];
    /** Lists that were asked for but hold no rows yet (never imported, or every import failed). */
    missingLists: string[];
    /** False when a requested list is missing, its last refresh failed, or its copy is older than two refresh intervals. */
    complete: boolean;
    /** The requested lists that make the result incomplete. */
    incompleteLists: string[];
    /** One sentence per such list. */
    warnings: string[];
    checkedAt: string;
    note: string;
}

/** No requested list holds any data: a screening would say "no match" without having looked. */
export class ListsUnavailableError extends Error {
    code = 'lists_unavailable' as const;
    constructor() {
        super('None of the requested sanctions lists has been imported on this server yet, so nothing could be screened. Try again later; a platform admin sees the import under Platform services, Sanctions lists.');
        this.name = 'ListsUnavailableError';
    }
}

export type AccessRefusal = { ok: false; code: 'feature_locked' | 'integration_off' | 'forbidden'; error: string };

export interface ServiceDeps {
    store: () => Pick<SanctionsStore, 'candidates' | 'listStatus' | 'recordDemand'>;
    hasFeature: (scope: { organizationId?: string | null; userId?: string | null }, feature: string) => Promise<boolean>;
    log: { info: (m: string) => void };
    /** Hours between refreshes (SANCTIONS_REFRESH_INTERVAL_HOURS); a copy older than twice that is stale. */
    intervalHours?: () => number;
}

function defaultDeps(): ServiceDeps {
    return {
        store: () => nodeRequire('../../stores/sanctionsStore.mts').sanctionsStore(),
        hasFeature: (scope, feature) => nodeRequire('../../license/index.js').hasFeature(scope, feature),
        log: nodeRequire('../../telemetry/log.js'),
        intervalHours: () => (nodeRequire('../../utils/envNumber.mts') as { envInt: (n: string, f: number, b?: { min?: number }) => number }).envInt('SANCTIONS_REFRESH_INTERVAL_HOURS', 24, { min: 0 }),
    };
}

let overrides: Partial<ServiceDeps> | null = null;
/** Test seam: replace any dependency; null restores the real ones. */
export function _setServiceDeps(o: Partial<ServiceDeps> | null): void { overrides = o; }
const deps = (): ServiceDeps => ({ ...defaultDeps(), ...(overrides ?? {}) });

export const NOTE = 'Candidates are possible matches for a person to check against the list entry (reference and link), not a finding. '
    + 'The screening ran on this server against the stored official lists; nothing was sent outside it.';
export const INCOMPLETE_NOTE = 'This screening is NOT complete: some requested lists are missing, failed to refresh or are out of date (see warnings). '
    + 'No candidate does not mean no match on those lists. ';

/**
 * May this user (in this organisation) screen? `integrationOn` answers whether the org admin's
 * switch is on for the user; the tool path leaves it out because getIntegrationTools only
 * offers the tool when it is (core/integrations/integrationToolFeatures.js).
 */
export async function access(
    scope: { userId?: string | null; orgId?: string | null },
    integrationOn?: (userId: string) => Promise<boolean>,
): Promise<{ ok: true } | AccessRefusal> {
    const d = deps();
    if (!scope.userId) return { ok: false, code: 'forbidden', error: 'Sanctions screening needs a signed-in owner.' };
    const licensed = await d.hasFeature({ organizationId: scope.orgId ?? null, userId: scope.userId }, LICENCE_FEATURE).catch(() => false);
    if (!licensed) return { ok: false, code: 'feature_locked', error: 'Sanctions screening is not part of this licence.' };
    const on = integrationOn ? await integrationOn(scope.userId).catch(() => false) : true;
    if (!on) return { ok: false, code: 'integration_off', error: 'Sanctions lists are switched off for this organisation. An organisation admin switches them on under Integrations.' };
    return { ok: true };
}

const str = (v: unknown, max = MAX_NAME_CHARS): string => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');

function listsOf(v: unknown): string[] | null {
    const raw = Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split(',') : [];
    const known = new Set(LIST_SOURCES.map((s) => s.id));
    const ids = raw.map((x) => String(x).trim()).filter((x) => known.has(x));
    return ids.length ? [...new Set(ids)] : null;
}

const numberOf = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    return Number.isFinite(n) ? n : undefined;
};

const HOUR_MS = 3_600_000;

function infoOf(id: string, r: ListStatusRow | undefined, staleBefore: number): ListInfo {
    const label = LIST_SOURCES.find((src) => src.id === id)?.label ?? id;
    const entityCount = r?.entityCount ?? 0;
    const last = r?.lastSuccessAt ? Date.parse(r.lastSuccessAt) : NaN;
    const stale = entityCount > 0 && !(last >= staleBefore);
    return { id, label, status: r?.status ?? 'never', lastSuccessAt: r?.lastSuccessAt ?? null, entityCount, stale, lastError: r?.lastError ?? null };
}

/** Why this list makes a screening incomplete, or null when it does not. */
function warningOf(info: ListInfo): string | null {
    if (!info.entityCount) return `${info.label}: not imported on this server yet, so it was not screened.`;
    const since = info.lastSuccessAt ?? 'an earlier refresh';
    if (info.status === 'error') return `${info.label}: the last refresh failed${info.lastError ? ` (${info.lastError})` : ''}; screened against the copy of ${since}.`;
    if (info.stale) return `${info.label}: the copy dates from ${since} and is out of date.`;
    return null;
}

function oneList(id: string, r: ListStatusRow | undefined, staleBefore: number): { info: ListInfo; warning: string | null } {
    const info = infoOf(id, r, staleBefore);
    return { info, warning: warningOf(info) };
}

function listInfo(rows: ListStatusRow[], wanted: string[] | null, intervalHours: number) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const staleBefore = Date.now() - 2 * Math.max(intervalHours, 24) * HOUR_MS;
    const lists: ListInfo[] = [];
    const missing: string[] = [];
    const incomplete: string[] = [];
    const warnings: string[] = [];
    for (const id of wanted ?? LIST_SOURCES.map((s) => s.id)) {
        const { info, warning } = oneList(id, byId.get(id), staleBefore);
        lists.push(info);
        if (!info.entityCount) missing.push(id);
        if (warning) { incomplete.push(id); warnings.push(warning); }
    }
    return { lists, missing, incomplete, warnings };
}

/**
 * Screen one name (and optionally a function) against the stored lists. Throws
 * ListsUnavailableError when a name was given and no requested list holds data, and a store
 * error as it is. Missing lists are reported to the refresh job (recordDemand), which then
 * fetches them within the hour, also for a user without an organisation.
 */
export async function screen(input: ScreenInput): Promise<ScreenResult> {
    const d = deps();
    const name = str(input.name);
    const fn = str(input.function);
    const lists = listsOf(input.lists);
    const opts = screenOptions({ minScore: numberOf(input.minScore), maxResults: numberOf(input.maxResults), lists });
    const store = d.store();
    const { lists: infos, missing, incomplete, warnings } = listInfo(await store.listStatus(), lists, d.intervalHours ? d.intervalHours() : 24);
    if (missing.length) await store.recordDemand().catch(() => undefined);
    if (name && missing.length === infos.length) throw new ListsUnavailableError();
    let candidates: Candidate[] = [];
    if (name) {
        const rows = await store.candidates(nameKeys(name), lists, CANDIDATE_LIMIT);
        candidates = screenCandidates({ name, birthDate: str(input.birthDate, 40) || null, country: str(input.country, 80) || null }, rows, opts);
    }
    const pep = fn ? checkPepFunction(fn) : null;
    d.log.info(`[sanctions] screening done: ${candidates.length} candidate(s)${pep ? `, pep=${pep.isPep}` : ''}`);
    return {
        screened: !!name, candidates, candidateCount: candidates.length, pep,
        lists: infos, missingLists: missing, complete: incomplete.length === 0, incompleteLists: incomplete, warnings,
        checkedAt: new Date().toISOString(), note: incomplete.length ? INCOMPLETE_NOTE + NOTE : NOTE,
    };
}
