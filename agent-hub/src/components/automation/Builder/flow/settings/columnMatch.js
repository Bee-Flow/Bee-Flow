/**
 * Column-title matching for the Nextcloud Tables row steps
 * (`nextcloud_tables_create_row` / `nextcloud_tables_update_row`).
 *
 * The `values` input of those steps is a map keyed by COLUMN TITLE. The AI
 * that fills it keys it by the field names of its own extraction step
 * (`excl_btw`, `amount_total`), and a person types whatever spelling comes to
 * mind ("Excl. btw", "excl btw"). The harmless differences — case, accents,
 * punctuation, underscores — should not fail the row; anything beyond that
 * ("amount_total" → "Totaal") is a guess, and a guess writes into the wrong
 * column silently. So matching is normalisation and nothing else.
 *
 * `normaliseColumnKey` MIRRORS server/integrations/nextcloudTablesTools.js
 * character for character — the server resolves keys with the same function
 * at run time, so what this editor shows as "matched" is exactly what the tool
 * accepts. columnMatch.test.js reads the server file and asserts the two agree.
 *
 * Pure module: no React, no DOM, no imports.
 */

/**
 * A title (or a field name) as a matching key: lower-case, diacritics
 * stripped, every character that is not a letter or a digit dropped.
 * "Excl. btw", "excl_btw", "EXCL BTW" and "Excl.btw" all become "exclbtw";
 * "Prijs (€)" becomes "prijs"; "Datum — Überweisung" becomes "datumuberweisung".
 */
export function normaliseColumnKey(title) {
    return String(title ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

/**
 * Group names by their normalised key. Returns a Map<norm, string[]> — the
 * array is every ORIGINAL spelling that collapsed onto that key, so a caller
 * can tell "one match" from "two things that look the same once normalised".
 */
function groupByNorm(names) {
    const out = new Map();
    for (const raw of names || []) {
        const name = String(raw ?? '');
        const norm = normaliseColumnKey(name);
        if (!norm) continue;
        if (!out.has(norm)) out.set(norm, []);
        out.get(norm).push(name);
    }
    return out;
}

/**
 * Match upstream field names onto column titles by normalised key.
 *
 * Rules, in the server's order of precedence:
 *   1. A column whose normalised key is shared by ANOTHER column is ambiguous:
 *      it is never matched ("Btw" and "BTW." — a value could land in either).
 *   2. Exactly one field with that key → the match.
 *   3. Several fields with that key → the one whose lower-cased name equals
 *      the column's lower-cased title wins (exact beats normalised, the same
 *      tie-break the server applies). No exact one → ambiguous, no match.
 *
 * @param {string[]} fieldNames    names of the upstream fields on offer
 * @param {string[]} columnTitles  titles of the table's columns
 * @returns {{
 *   byColumn: Record<string, string>,  column title → field name
 *   unmatchedFields: string[],         fields that landed nowhere
 *   unmatchedColumns: string[],        columns nothing landed in (ambiguous ones included)
 *   ambiguous: string[],               columns skipped because ≥2 names collapsed onto them
 * }}
 */
export function matchColumns(fieldNames, columnTitles) {
    const fields = groupByNorm(fieldNames);
    const columns = groupByNorm(columnTitles);
    const byColumn = {};
    const ambiguous = [];
    const usedFields = new Set();

    for (const title of columnTitles || []) {
        const norm = normaliseColumnKey(title);
        if (!norm) continue;
        const siblings = columns.get(norm) || [];
        if (siblings.length > 1) { ambiguous.push(String(title)); continue; }
        const candidates = fields.get(norm) || [];
        if (!candidates.length) continue;
        let pick = candidates.length === 1 ? candidates[0] : null;
        if (!pick) {
            const lower = String(title).toLowerCase();
            const exact = candidates.filter(c => c.toLowerCase() === lower);
            if (exact.length === 1) pick = exact[0];
        }
        if (!pick) { ambiguous.push(String(title)); continue; }
        byColumn[String(title)] = pick;
        usedFields.add(pick);
    }

    const unmatchedFields = (fieldNames || [])
        .map(f => String(f ?? ''))
        .filter(f => f && !usedFields.has(f));
    const unmatchedColumns = (columnTitles || [])
        .map(c => String(c ?? ''))
        .filter(c => c && !(c in byColumn));
    return { byColumn, unmatchedFields, unmatchedColumns, ambiguous };
}

/**
 * Which column would the server write a given `values` key into?
 *
 * Mirrors resolveValues in nextcloudTablesTools.js: exact title (case-
 * insensitive) first, then a numeric column id, then the normalised key —
 * but only when that key is UNIQUE among the columns. Returns the column
 * object or null. Used to put an AI-written key such as `excl_btw` on the
 * "Excl. btw" row of the editor rather than in the "not a column" group,
 * because at run time it does reach that column.
 *
 * @param {string} key
 * @param {Array<{ id?: number|string, title: string }>} columns
 */
export function resolveKeyToColumn(key, columns) {
    const k = String(key ?? '');
    if (!k) return null;
    const lower = k.toLowerCase();
    const list = columns || [];
    const exact = list.find(c => String(c?.title ?? '').toLowerCase() === lower);
    if (exact) return exact;
    const byId = list.find(c => c?.id != null && String(c.id) === k);
    if (byId) return byId;
    const norm = normaliseColumnKey(k);
    if (!norm) return null;
    const hits = list.filter(c => normaliseColumnKey(c?.title) === norm);
    return hits.length === 1 ? hits[0] : null;
}
