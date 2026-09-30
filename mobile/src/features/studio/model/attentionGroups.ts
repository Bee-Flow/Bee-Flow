/**
 * "Needs attention" folded for a phone: findings with the same source and code
 * are one line ("App has validation problems · 12"), so eighty warnings of
 * one kind read as one thing to fix rather than eighty sentences. A group of
 * one keeps the producer's own sentence, which names the object.
 *
 * The server already orders rows by severity; groups keep the order of their
 * first row, so the worst still comes first.
 */

import type { AttentionRow } from './api';
import { SOURCE_LABELS } from './attention';

export interface AttentionGroup {
    /** `source:code` — stable across refreshes. */
    key: string;
    source: string;
    code: string;
    severity: AttentionRow['severity'];
    kind: string | null;
    rows: AttentionRow[];
}

const RANK = { error: 0, warning: 1, info: 2 } as const;

export function groupAttention(rows: readonly AttentionRow[]): AttentionGroup[] {
    const byKey = new Map<string, AttentionGroup>();
    for (const row of rows) {
        const key = `${row.source}:${row.code}`;
        const group = byKey.get(key);
        if (!group) {
            byKey.set(key, { key, source: row.source, code: row.code, severity: row.severity, kind: row.kind, rows: [row] });
            continue;
        }
        group.rows.push(row);
        if (RANK[row.severity] < RANK[group.severity]) group.severity = row.severity;
    }
    return [...byKey.values()];
}

/**
 * The words for a group: one finding speaks for itself (its sentence, or its
 * source's line when the producer sent none); several are named by their
 * source, and `detail` is the remediation they share, which tells two codes of
 * one source apart ("Publishing checks it exists.").
 */
export interface GroupWords {
    title: { text: string } | { key: string; fallback: string };
    detail: string | null;
}

/** The group's source line (the web's SOURCE_LABELS), or its code for a source this port does not know. */
export function sourceWords(group: Pick<AttentionGroup, 'source' | 'code'>): GroupWords['title'] {
    const label = SOURCE_LABELS[group.source];
    return label ? { key: label[0], fallback: label[1] } : { text: group.code };
}

export function groupWords(group: AttentionGroup): GroupWords {
    const [first] = group.rows;
    if (group.rows.length === 1 && first) {
        return { title: first.message ? { text: first.message } : sourceWords(group), detail: first.remediation };
    }
    const shared = first?.remediation && group.rows.every((r) => r.remediation === first.remediation) ? first.remediation : null;
    return { title: sourceWords(group), detail: shared };
}
