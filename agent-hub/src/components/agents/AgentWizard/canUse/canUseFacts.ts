/**
 * canUseFacts: the FACTS behind the "Can use" tab, separate from how they are drawn (Bee Flow Builder redesign,
 * Sep 2026; Agents artboard 1a, A2 step 2).
 *
 * Everything here is pure: the raw answers of the server go in, plus the agent's own config, and rows of FACTS
 * come out. No sentences. The sentences are in the cards, because that is where the literal t() keys that the
 * i18n guard reads are.
 *
 * ── THREE STATES, NOT TWO ───────────────────────────────────────────
 * Every source carries a `READ` state, because "not read yet", "read and empty" and "cannot be read" are three
 * different answers, and only one of them may reach the screen as "the agent has nothing". A failed fetch that
 * lands on `[]` is the classic way to lose that difference: the card then says flatly "no knowledge linked"
 * about an agent with five knowledge bases.
 *
 * ── A LINKED ID THAT NOBODY KNOWS DOES NOT DISAPPEAR ────────────────
 * The LINK is in the agent's config, and we always read that. The NAME comes from a list that may be missing (a
 * knowledge base outside `?context=agent`, a table behind the automations module, a skill without the `skills`
 * capability). Such a row therefore becomes `readable: false`. It stays, with its id, and the card says that the
 * name could not be read. Filtering it out would deny the link itself: the agent does use it.
 *
 * ── THE TABLE SIDE MIRRORS THE SERVER, INCLUDING ITS NARROWINGS ─────
 * `server/core/agentRuntime/toolPolicy.js` (`datatableGrantsOf` / `normaliseToolsConfig`) reads
 * `config.tools.datatables` again on BOTH sides, and narrows while doing so: an unknown `scope` becomes `'own'`,
 * an unreadable `columns` becomes `[]` (= the table is refused), and above 25 grants only the first 25 count.
 * This module does exactly the same, because a card that says "all rows" where the runtime does "only own rows"
 * is precisely the stored promise without enforcement that that file forbids.
 */

/** De leesbaarheid van een bron. `LOADING` is nooit hetzelfde als `OK` met nul rijen. */
export const READ = Object.freeze({ LOADING: 'loading', OK: 'ok', ERROR: 'error' });

export type ReadState = (typeof READ)[keyof typeof READ];

export type DatatableScope = 'own' | 'all';

/** Eén gegunde tabel: `columns` is `'*'` (elke gedeclareerde kolom) of de gekozen lijst. */
export interface DatatableGrant {
    id: string;
    scope: DatatableScope;
    columns: string[] | '*';
}

export interface DatatableGrants {
    grants: DatatableGrant[];
    /** The number of grants that the runtime NO LONGER takes along. */
    truncated: number;
}

/** Wat een lijst-route per rij kan dragen om op id te indexeren. */
interface Identified {
    id?: unknown;
    ID?: unknown;
}

/** Een rij van `GET /api/kb?context=agent` (snake_case en camelCase naast elkaar). */
export interface KnowledgeBaseSource extends Identified {
    name?: unknown;
    documentCount?: unknown;
    document_count?: unknown;
    lastContentAt?: string | null;
    last_content_at?: string | null;
}

export interface KnowledgeBaseRow {
    id: string;
    name: string | null;
    documentCount: number | null;
    lastContentAt: string | null;
    readable: boolean;
}

/** Een rij van `GET /api/datatables`. */
export interface DatatableSource extends Identified {
    name?: unknown;
}

export interface DatatableRow {
    id: string;
    name: string | null;
    scope: DatatableScope;
    columns: string[] | '*';
    grantsNothing: boolean;
    readable: boolean;
}

/** Een skill zoals de skill-routes hem geven. */
export interface SkillSource extends Identified {
    name?: unknown;
    icon?: unknown;
    steps?: unknown;
    rulesV2?: unknown;
}

export interface SkillRow {
    id: string;
    name: string | null;
    icon: string | null;
    stepCount: number | null;
    ruleCount: number | null;
    otherAgents: number | null;
    readable: boolean;
}

/** Spiegelt toolPolicy.js — hoger telt de runtime niet mee. */
export const MAX_DATATABLE_GRANTS = 25;

/** Spiegelt toolPolicy.js: `scope` is een TOEGANGSvraag, dus onbekend ⇒ de smalle. */
const DATATABLE_SCOPES: readonly unknown[] = Object.freeze(['own', 'all']);

/** Keys that a plain object cannot safely carry (toolPolicy.js). */
const UNSAFE_OBJECT_KEYS: ReadonlySet<string> = Object.freeze(new Set(['__proto__', 'constructor', 'prototype']));

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * A finite, non-negative integer, or `null` if it is not one.
 *
 * `null`, `undefined` and `''` are caught FIRST, before `Number()`. That function turns `null` and `''` into 0,
 * and that is precisely the zero this function is supposed to keep out: a missing counter that appears on the
 * screen as "zero documents".
 */
export function countOrNull(value?: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * `'*'` (every declared column) or the chosen list. Mirror of `_datatableColumns` in toolPolicy.js.
 * Unreadable ⇒ `[]`, and `[]` there means "no columns", not "all".
 */
export function datatableColumnsOf(raw?: unknown): string[] | '*' {
    if (raw === undefined || raw === null || raw === '*') return '*';
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out: string[] = [];
    for (const c of raw) {
        if (typeof c !== 'string' || !c || seen.has(c)) continue;
        seen.add(c);
        out.push(c);
    }
    return out;
}

/**
 * The granted tables from `config.tools`, as `[{ id, scope, columns }]` in config order. Never an exception:
 * this runs in a render.
 */
export function datatableGrantsOf(toolsConfig?: unknown): DatatableGrants {
    const empty: DatatableGrants = { grants: [], truncated: 0 };
    try {
        if (!isPlainObject(toolsConfig) || !isPlainObject(toolsConfig.datatables)) return empty;
        const allIds = Object.keys(toolsConfig.datatables).filter(id => !UNSAFE_OBJECT_KEYS.has(id));
        const ids = allIds.slice(0, MAX_DATATABLE_GRANTS);
        const grants = ids.map((id): DatatableGrant => {
            const raw = (toolsConfig.datatables as Record<string, unknown>)[id];
            // No object ⇒ narrowest possible, just like the server: the table stays in place (the id is the readable
            // half) but yields nothing.
            if (!isPlainObject(raw)) return { id, scope: 'own', columns: [] };
            return {
                id,
                scope: DATATABLE_SCOPES.includes(raw.scope) ? raw.scope as DatatableScope : 'own',
                columns: datatableColumnsOf(raw.columns),
            };
        });
        return { grants, truncated: allIds.length - ids.length };
    } catch (_) {
        // An unreadable section grants nothing, and says so via READ.ERROR to the caller, not via a silent empty
        // list here.
        return empty;
    }
}

/**
 * Turns a list of objects into a `Map` keyed by id. A list that is not a list yields an EMPTY map plus `false`.
 * That tells the caller that it could not index anything, and it must not read that as "there is nothing".
 */
function indexById<T extends Identified>(list: (T | null | undefined)[] | null | undefined): Map<string, T | null | undefined> | null {
    if (!Array.isArray(list)) return null;
    const map = new Map<string, T | null | undefined>();
    for (const row of list) {
        const id = row && (row.id ?? row.ID);
        if (typeof id === 'string' && id) map.set(id, row);
    }
    return map;
}

/** Unique, in order, non-empty strings only. */
function uniqueIds(ids: unknown): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of Array.isArray(ids) ? ids : []) {
        if (typeof id !== 'string' || !id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

/**
 * The knowledge base rows: the linked ids of the agent, supplemented with what the list from
 * `GET /api/kb?context=agent` knows about them.
 *
 * `documentCount` and `lastContentAt` are on that route in SNAKE_CASE (`decorateKbList` only runs on
 * the detail routes), so both spellings are read. A missing counter becomes `null` and NEVER 0: "zero
 * documents" is a claim about a knowledge base that you have not measured.
 */
export function knowledgeBaseRows({ ids, kbs, state = READ.OK }: {
    ids?: readonly string[] | null;
    kbs?: (KnowledgeBaseSource | null | undefined)[] | null;
    state?: ReadState;
}): KnowledgeBaseRow[] {
    const linked = uniqueIds(ids);
    const index = state === READ.OK ? indexById(kbs) : null;
    return linked.map((id) => {
        const kb = index ? index.get(id) : null;
        if (!kb) return { id, name: null, documentCount: null, lastContentAt: null, readable: false };
        return {
            id,
            name: typeof kb.name === 'string' && kb.name ? kb.name : null,
            documentCount: countOrNull(kb.documentCount ?? kb.document_count),
            lastContentAt: kb.lastContentAt ?? kb.last_content_at ?? null,
            readable: true,
        };
    });
}

/**
 * De tabelrijen: de grants uit de agentconfig, aangevuld met de naam uit
 * `GET /api/datatables` — een route die achter de automations-module hangt,
 * dus de naam ontbreekt geregeld terwijl de grant er wel degelijk is.
 */
export function datatableRows({ toolsConfig, tables, state = READ.OK }: {
    toolsConfig?: unknown;
    tables?: (DatatableSource | null | undefined)[] | null;
    state?: ReadState;
}): { rows: DatatableRow[]; truncated: number } {
    const { grants, truncated } = datatableGrantsOf(toolsConfig);
    const index = state === READ.OK ? indexById(tables) : null;
    const rows = grants.map((g) => {
        const table = index ? index.get(g.id) : null;
        return {
            id: g.id,
            name: table && typeof table.name === 'string' && table.name ? table.name : null,
            scope: g.scope,
            columns: g.columns,
            // No columns = the runtime refuses this table outright. That is a FACT about the grant, and it stands
            // apart from whether we could read the name.
            grantsNothing: Array.isArray(g.columns) && g.columns.length === 0,
            readable: !!table,
        };
    });
    return { rows, truncated };
}

/**
 * "also used by k OTHER agents".
 *
 * The summary (`GET /api/skills/usage-summary`) counts EVERY agent that links the skill, this one
 * included. `selfCounted` says whether that is so; only then does one come off. Unknown stays `null`,
 * because a counter that was not read may not be read as 0 ("nobody else uses this").
 */
export function otherAgentUsers(count?: unknown, selfCounted?: boolean): number | null {
    const n = countOrNull(count);
    if (n === null) return null;
    return Math.max(0, n - (selfCounted ? 1 : 0));
}

/**
 * The skill rows: the linked ids, supplemented with the skill itself and with the usage count.
 *
 * `steps` and `rulesV2` are `[]` as long as the one-time parse has not run (skillStore.mapRow presents
 * NULL as `[]`), so 0 steps here is a real 0 and not a gap. `usage` is a separate read with its own state:
 * that can fail while the skills themselves were read fine.
 */
export function skillRows({ ids, skills, state = READ.OK, usage, usageState = READ.OK, savedSkillIds, agentSaved = false }: {
    ids?: readonly string[] | null;
    skills?: (SkillSource | null | undefined)[] | null;
    state?: ReadState;
    usage?: unknown;
    usageState?: ReadState;
    savedSkillIds?: readonly string[] | null;
    agentSaved?: boolean;
}): SkillRow[] {
    const attached = uniqueIds(ids);
    const index = state === READ.OK ? indexById(skills) : null;
    const saved = new Set(uniqueIds(savedSkillIds));
    const summary = usageState === READ.OK && isPlainObject(usage) ? usage : null;
    return attached.map((id) => {
        const skill = index ? index.get(id) : null;
        // The count comes from the server and knows only the SAVED config.
        // A skill that you just ticked is not in it yet, so it does not count itself either, and then nothing may come off.
        const selfCounted = agentSaved && saved.has(id);
        const entry = summary ? summary[id] : null;
        const others = summary ? otherAgentUsers(isPlainObject(entry) ? entry.agents : null, selfCounted) : null;
        if (!skill) {
            return { id, name: null, icon: null, stepCount: null, ruleCount: null, otherAgents: others, readable: false };
        }
        return {
            id,
            name: typeof skill.name === 'string' && skill.name ? skill.name : null,
            icon: typeof skill.icon === 'string' && skill.icon ? skill.icon : null,
            stepCount: Array.isArray(skill.steps) ? skill.steps.length : null,
            ruleCount: Array.isArray(skill.rulesV2) ? skill.rulesV2.length : null,
            otherAgents: others,
            readable: true,
        };
    });
}

/**
 * May the card say "nothing is here"?
 *
 * Only if EVERY source has been read AND no single row came out of it. One source that is still loading,
 * or that broke, makes the answer unknown, and unknown is not empty.
 */
export function isTrulyEmpty(states?: ReadState[] | null, rowCounts?: number[] | null): boolean {
    const allRead = (Array.isArray(states) ? states : []).every(s => s === READ.OK);
    const noRows = (Array.isArray(rowCounts) ? rowCounts : []).every(n => n === 0);
    return allRead && noRows;
}

/** Heeft minstens één van deze bronnen gefaald? */
export function anyFailed(states?: ReadState[] | null): boolean {
    return (Array.isArray(states) ? states : []).some(s => s === READ.ERROR);
}
