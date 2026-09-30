/**
 * Column-title matching for the Nextcloud Tables row steps. The `values` input
 * is keyed by COLUMN TITLE; harmless differences (case, accents, punctuation,
 * underscores) must not fail the row, and anything beyond that is a guess — so
 * matching is normalisation and nothing else. `normaliseColumnKey` mirrors
 * server/integrations/nextcloudTablesTools.js character for character. Port of
 * agent-hub `Builder/flow/settings/columnMatch.js`; pinned by
 * settings.lockstep.test.ts.
 */

/** "Excl. btw", "excl_btw", "EXCL BTW" → "exclbtw"; "Prijs (€)" → "prijs". */
export function normaliseColumnKey(title: unknown): string {
    return String(title ?? '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

/** Names grouped by normalised key, every ORIGINAL spelling kept. */
function groupByNorm(names: unknown[] | null | undefined): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const raw of names || []) {
        const name = String(raw ?? '');
        const norm = normaliseColumnKey(name);
        if (!norm) continue;
        out.set(norm, [...(out.get(norm) || []), name]);
    }
    return out;
}

export interface ColumnMatch {
    byColumn: Record<string, string>;
    unmatchedFields: string[];
    unmatchedColumns: string[];
    ambiguous: string[];
}

/** Several fields on one key: the exact (case-insensitive) spelling wins, else none. */
function pickField(title: string, candidates: string[]): string | null {
    if (candidates.length === 1) return candidates[0] as string;
    const lower = title.toLowerCase();
    const exact = candidates.filter((c) => c.toLowerCase() === lower);
    return exact.length === 1 ? (exact[0] as string) : null;
}

/**
 * Upstream field names onto column titles, in the server's precedence: a key
 * shared by two COLUMNS is ambiguous; one field on the key matches; several
 * fields match only on an exact spelling.
 */
export function matchColumns(fieldNames: unknown[] | null | undefined, columnTitles: unknown[] | null | undefined): ColumnMatch {
    const fields = groupByNorm(fieldNames);
    const columns = groupByNorm(columnTitles);
    const byColumn: Record<string, string> = {};
    const ambiguous: string[] = [];
    const usedFields = new Set<string>();
    for (const title of columnTitles || []) {
        const norm = normaliseColumnKey(title);
        if (!norm) continue;
        if ((columns.get(norm) || []).length > 1) {
            ambiguous.push(String(title));
            continue;
        }
        const candidates = fields.get(norm) || [];
        if (!candidates.length) continue;
        const pick = pickField(String(title), candidates);
        if (!pick) ambiguous.push(String(title));
        else {
            byColumn[String(title)] = pick;
            usedFields.add(pick);
        }
    }
    const unmatchedFields = (fieldNames || []).map((f) => String(f ?? '')).filter((f) => f && !usedFields.has(f));
    const unmatchedColumns = (columnTitles || []).map((c) => String(c ?? '')).filter((c) => c && !(c in byColumn));
    return { byColumn, unmatchedFields, unmatchedColumns, ambiguous };
}

export interface TableColumn {
    id?: number | string | null;
    title: string;
    [key: string]: unknown;
}

/**
 * The column the server would write a `values` key into: exact title, then a
 * numeric column id, then the normalised key — only when that key is UNIQUE.
 */
export function resolveKeyToColumn<C extends Partial<TableColumn>>(key: unknown, columns: C[] | null | undefined): C | null {
    const k = String(key ?? '');
    if (!k) return null;
    const lower = k.toLowerCase();
    const list = columns || [];
    const exact = list.find((c) => String(c?.title ?? '').toLowerCase() === lower);
    if (exact) return exact;
    const byId = list.find((c) => c?.id != null && String(c.id) === k);
    if (byId) return byId;
    const norm = normaliseColumnKey(k);
    if (!norm) return null;
    const hits = list.filter((c) => normaliseColumnKey(c?.title) === norm);
    return hits.length === 1 ? (hits[0] as C) : null;
}
