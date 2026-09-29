import { walkPath } from './resolveBinding';

/**
 * App Studio runtime — the list peek: what is BEHIND a row.
 *
 * A sidebar row saying "needs attention" is only half an answer; the other
 * half — WHICH lines, and what is missing from them — costs a click to reach,
 * which is the click the sidebar exists to save. The peek joins a second query
 * to the list rows so the count lands in the badge and the rows themselves
 * float in a panel on hover.
 *
 * Pure functions, deliberately outside AppList: the join, the counting and the
 * truncation are the parts worth testing, and none of them need a DOM.
 */

/**
 * The join value, as a string. Both sides go through this, so a numeric id on
 * one side and its text form on the other still meet.
 */
export const peekKey = (v) => (v == null ? '' : String(v));

const norm = peekKey;

/**
 * Index the related rows by their join value.
 *
 * `countKey` is what makes an AGGREGATE source work: it hands back one row per
 * group with the count in a field, so the entry's count is the SUM of that
 * field rather than the number of rows. Without it every row counts as one,
 * which is what a plain `records` source means.
 *
 * Related rows whose join value is empty are dropped rather than collected
 * under "": they match no list row, and a bucket nothing can reach is only a
 * way to make the totals wrong.
 */
export function buildPeekIndex(rows, { matchKey, countKey = null, groupKey = null, groupLabelMap = [] } = {}) {
    const index = new Map();
    if (!Array.isArray(rows) || !matchKey) return index;
    const labels = new Map(
        (Array.isArray(groupLabelMap) ? groupLabelMap : [])
            .filter((m) => m && m.value != null)
            .map((m) => [String(m.value), m]),
    );
    for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const key = norm(walkPath(row, matchKey));
        if (!key) continue;
        let entry = index.get(key);
        if (!entry) {
            entry = { count: 0, rows: [], groups: [] };
            index.set(key, entry);
        }
        const raw = countKey ? Number(walkPath(row, countKey)) : 1;
        const weight = Number.isFinite(raw) ? raw : 0;
        entry.count += weight;
        entry.rows.push(row);
        if (groupKey) {
            const value = norm(walkPath(row, groupKey));
            let group = entry.groups.find((g) => g.value === value);
            if (!group) {
                const mapped = labels.get(value);
                const label = mapped && mapped.label != null && mapped.label !== '' ? mapped.label : value;
                group = { value, label, tone: (mapped && mapped.tone) || null, count: 0, rows: [] };
                entry.groups.push(group);
            }
            group.count += weight;
            group.rows.push(row);
        }
    }
    // Biggest group first. It is the one whose label goes in the badge, and the
    // one worth reading first in the panel.
    for (const entry of index.values()) entry.groups.sort((a, b) => b.count - a.count);
    return index;
}

/**
 * The badge text for a row: "14 controleren" instead of "Nakijken".
 *
 * The count alone would be a riddle, so the word next to it is the biggest
 * group's label — the reason most of those rows are waiting. With no groupKey
 * configured the row's own badge label carries the meaning and the count is
 * simply put in front of it.
 *
 * A row with nothing related keeps its plain badge: zero is not news, and
 * "0 controleren" on every finished row is noise on the rows that are fine.
 */
export function peekBadgeLabel(entry, fallback) {
    if (!entry || !entry.count) return fallback;
    const word = entry.groups.length ? entry.groups[0].label : fallback;
    return word ? `${entry.count} ${word}` : String(entry.count);
}

/**
 * The tone the badge takes when the count replaces its label — the biggest
 * group's, if the author gave it one. Null keeps the row's own tone, which is
 * the identity answer for every peek configured without tones.
 */
export function peekBadgeTone(entry) {
    if (!entry || !entry.count || !entry.groups.length) return null;
    return entry.groups[0].tone || null;
}

/**
 * What the panel shows: sections in group order, capped at `limit` ROWS in
 * total, plus how many rows did not fit.
 *
 * The cap is the point. A request with 87 incomplete lines has a hover panel
 * taller than the screen, and a panel that runs off the bottom is worse than
 * one that says "+ 81 meer" and leaves the full list to the tab that owns it.
 */
export function peekSections(entry, limit) {
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 6;
    if (!entry || !entry.rows.length) return { sections: [], more: 0 };
    const groups = entry.groups.length
        ? entry.groups
        : [{ value: '', label: null, tone: null, count: entry.count, rows: entry.rows }];
    const sections = [];
    let shown = 0;
    for (const group of groups) {
        if (shown >= cap) break;
        const rows = group.rows.slice(0, cap - shown);
        shown += rows.length;
        sections.push({ value: group.value, label: group.label, count: group.count, rows });
    }
    return { sections, more: Math.max(0, entry.rows.length - shown) };
}
