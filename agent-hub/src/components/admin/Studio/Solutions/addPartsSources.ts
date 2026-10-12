import { API_BASE, authFetch } from '../../../../utils/helpers';
import { SECTIONS, itemLabel, type SolutionSection } from './solutionSections';

/**
 * Where "Add to this Solution" gets its candidates, and how a candidate becomes
 * a row. No React in here: the panel renders what this reads.
 *
 * ── Every kind reads ITS OWN listing ────────────────────────────────────────
 *
 * An automation is listed by `GET /api/automation` (the Studio's own automations list
 * and `PUT /resources` kind `automation` are the same table). It used to point
 * at `/api/ai-tasks`, the older scheduled-task table, which is empty for anyone
 * who builds automations in Studio: the picker then said "Nothing of yours left to
 * add here" next to fourteen automations. A kind added to the registry in
 * server/projects/membership.js needs its listing here, or it is not offered.
 *
 * Skills and document templates are the two kinds that only a Solution holds.
 * A template is a studio document with `kind=template`; the server files it
 * through `studio_documents.solution_project_id`, which the listing reports as
 * `solutionProjectId` (a skill reports `projectId`, like the rest).
 *
 * ── The server stays the authority ──────────────────────────────────────────
 *
 * What is dropped here is only what could never succeed or is already settled:
 * what is in THIS Solution (the caller says so in `alreadyIn`) and what someone
 * else owns (a shared skill or automation appears in the caller's listing but is
 * not theirs to move). What belongs to ANOTHER Solution is kept and shown
 * disabled with that Solution's name: hiding it would read as "it is gone".
 * A refusal at filing time is shown in the server's own words.
 */

export const SOURCE: Record<string, string> = {
    notebook: `${API_BASE}/api/notebooks`,
    app: `${API_BASE}/api/studio-apps`,
    automation: `${API_BASE}/api/automation`,
    webpage: `${API_BASE}/api/webpages`,
    datatable: `${API_BASE}/api/datatables`,
    agent: `${API_BASE}/agents`,
    skill: `${API_BASE}/api/skills`,
    document_template: `${API_BASE}/api/studio-documents?kind=template&limit=200`,
    knowledge_base: `${API_BASE}/api/kb`,
};

/** The kinds that can be added from here, in the order the registry lists them. */
export const ADDABLE: SolutionSection[] = SECTIONS.filter(s => s.movable && SOURCE[s.kind]);

/** The array inside a listing response, whatever the endpoint calls it. */
export function rowsOf(body: unknown): unknown[] | null {
    if (Array.isArray(body)) return body;
    if (!body || typeof body !== 'object') return null;
    for (const value of Object.values(body)) {
        if (Array.isArray(value)) return value;
    }
    return null;
}

export interface AddItem {
    kind: string;
    id: string;
    label: string;
    /** The OTHER project this item is filed in, or null when it is free to add. */
    inProjectId: string | null;
}

export type KindLoad =
    | { status: 'loading' }
    | { status: 'error' }
    | { status: 'ok'; items: AddItem[] };

type Row = Record<string, unknown>;

/** Whose item a listing row says it is. Absent = the listing does not say; the server decides. */
const OWNER_FIELDS = ['userId', 'ownerId', 'ownerUserId'];

function isMine(row: Row, me: string | null | undefined): boolean {
    if (!me) return true;
    const stated = OWNER_FIELDS.filter(f => row[f] != null);
    return stated.length === 0 || stated.some(f => row[f] === me);
}

/** The project a row is filed in; a template says it with `solutionProjectId`. */
function projectOf(row: Row): string | null {
    for (const field of ['projectId', 'solutionProjectId']) {
        const value = row[field];
        if (typeof value === 'string' && value) return value;
    }
    return null;
}

/** Turn one listing body into addable rows. Null = the body was not a listing. */
export function itemsOf(kind: string, body: unknown, ctx: { projectId: string; alreadyIn: Set<string>; me?: string | null }): AddItem[] | null {
    const rows = rowsOf(body);
    if (rows === null) return null;
    const out: AddItem[] = [];
    for (const raw of rows) {
        if (!raw || typeof raw !== 'object') continue;
        const row = raw as Row;
        if (typeof row.id !== 'string' || !row.id) continue;
        const filedIn = projectOf(row);
        if (ctx.alreadyIn.has(`${kind}:${row.id}`) || filedIn === ctx.projectId) continue;
        if (!isMine(row, ctx.me)) continue;
        out.push({ kind, id: row.id, label: itemLabel(row as { id: string }), inProjectId: filedIn });
    }
    return out;
}

/** One kind's listing. A listing that cannot be read is an error, never an empty list. */
export async function loadKind(kind: string, ctx: { projectId: string; alreadyIn: Set<string>; me?: string | null }): Promise<KindLoad> {
    try {
        const res = await authFetch(SOURCE[kind]);
        const body: unknown = res.ok ? await res.json().catch(() => null) : null;
        const items = res.ok ? itemsOf(kind, body, ctx) : null;
        return items === null ? { status: 'error' } : { status: 'ok', items };
    } catch {
        return { status: 'error' };
    }
}

/** Solution id -> name, for "In <name>". A failed read is an empty map: the fallback wording covers it. */
export async function loadSolutionNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    try {
        const res = await authFetch(`${API_BASE}/api/projects/summary?checks=0`);
        const body: unknown = res.ok ? await res.json().catch(() => null) : null;
        const list = body && typeof body === 'object' ? (body as { projects?: unknown }).projects : null;
        for (const p of Array.isArray(list) ? list : []) {
            if (p && typeof p.id === 'string' && typeof p.name === 'string' && p.name) names.set(p.id, p.name);
        }
    } catch { /* the names are a courtesy */ }
    return names;
}

export type AttachResult = { ok: true } | { ok: false; body: unknown };

/** File one item into the Solution. The server decides; its refusal comes back as `body`. */
export async function attachItem(projectId: string, kind: string, id: string): Promise<AttachResult> {
    try {
        const res = await authFetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}/resources`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind, id, attach: true }),
        });
        if (res.ok) return { ok: true };
        return { ok: false, body: await res.json().catch(() => ({})) };
    } catch {
        return { ok: false, body: null };
    }
}
