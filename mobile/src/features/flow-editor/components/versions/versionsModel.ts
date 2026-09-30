/**
 * The version comparison's raw view, pure: two definitions compare as JSON
 * with sorted keys, so a reordered but equal object is not a change (arrays
 * keep their order: step order means something), and the line diff is an LCS
 * script, capped — a snapshot carrying large pinned outputs can be thousands
 * of lines, and above the cap the script is simply "all removed, all added".
 * The web's Versions tab compares per setting since handoff 5 (the server's
 * field diff); this line view is the phone's own.
 *
 * The phone reads a diff as ONE column, so the script is folded into hunks
 * with a little context around each change (`unifiedHunks`). The list's words
 * and groups are versionText.ts.
 */

function sortKeys(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
        return out;
    }
    return v;
}

export function stableStringify(value: unknown): string {
    return JSON.stringify(sortKeys(value ?? {}), null, 2);
}

export type DiffKind = 'keep' | 'del' | 'ins';

export interface DiffRow {
    kind: DiffKind;
    left: string;
    right: string;
}

/** ~16 MB of ints: comfortably fast; above it the script is coarse. */
export const LCS_MAX_CELLS = 2_000_000;

function lcsTable(a: readonly string[], b: readonly string[]): number[][] {
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
        const row = dp[i] as number[];
        const below = dp[i + 1] as number[];
        for (let j = m - 1; j >= 0; j -= 1) {
            row[j] = a[i] === b[j] ? (below[j + 1] as number) + 1 : Math.max(below[j] as number, row[j + 1] as number);
        }
    }
    return dp;
}

/** The side-by-side script: kept lines in both columns, removed on the left, added on the right. */
export function diffLines(a: readonly string[], b: readonly string[]): DiffRow[] {
    const n = a.length;
    const m = b.length;
    const rows: DiffRow[] = [];
    if ((n + 1) * (m + 1) > LCS_MAX_CELLS) {
        for (const line of a) rows.push({ kind: 'del', left: line, right: '' });
        for (const line of b) rows.push({ kind: 'ins', left: '', right: line });
        return rows;
    }
    const dp = lcsTable(a, b);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            rows.push({ kind: 'keep', left: a[i] as string, right: b[j] as string });
            i += 1;
            j += 1;
        } else if ((dp[i + 1]?.[j] as number) >= (dp[i]?.[j + 1] as number)) {
            rows.push({ kind: 'del', left: a[i] as string, right: '' });
            i += 1;
        } else {
            rows.push({ kind: 'ins', left: '', right: b[j] as string });
            j += 1;
        }
    }
    while (i < n) rows.push({ kind: 'del', left: a[i++] as string, right: '' });
    while (j < m) rows.push({ kind: 'ins', left: '', right: b[j++] as string });
    return rows;
}

/** One line of the one-column view, or a fold standing for unchanged lines. */
export type HunkLine = { kind: DiffKind; text: string; key: string } | { kind: 'gap'; count: number; key: string };

/** The script as one column: changes with `context` kept lines around them, the rest folded. */
export function unifiedHunks(rows: readonly DiffRow[], context = 2): HunkLine[] {
    const near = new Array<boolean>(rows.length).fill(false);
    rows.forEach((row, index) => {
        if (row.kind === 'keep') return;
        for (let k = Math.max(0, index - context); k <= Math.min(rows.length - 1, index + context); k += 1) near[k] = true;
    });
    const out: HunkLine[] = [];
    let folded = 0;
    rows.forEach((row, index) => {
        if (row.kind === 'keep' && !near[index]) {
            folded += 1;
            return;
        }
        if (folded) out.push({ kind: 'gap', count: folded, key: `gap-${index}` });
        folded = 0;
        out.push({ kind: row.kind, text: row.kind === 'ins' ? row.right : row.left, key: `line-${index}` });
    });
    if (folded) out.push({ kind: 'gap', count: folded, key: 'gap-end' });
    return out;
}

/** The two definitions as one column of changed lines. */
export function definitionDiff(before: unknown, after: unknown): HunkLine[] {
    return unifiedHunks(diffLines(stableStringify(before).split('\n'), stableStringify(after).split('\n')));
}
