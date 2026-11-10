/**
 * The two parts of a saved dataset's descriptor beside groupBy, aggregates and filters: how its rows are
 * ordered and how many are kept. The aggregate compiler reads `sort` (the first entry, by an OUTPUT column:
 * a breakdown or a measure alias) and `limit` (clamped by the server), so only those shapes are written.
 */

export interface DatasetSort {
    field: string;
    dir: 'asc' | 'desc';
}

interface DescriptorLike {
    groupBy?: Array<{ field?: string; bucket?: string; as?: string } | null>;
    aggregates?: Array<{ as?: string } | null>;
    [key: string]: unknown;
}

/**
 * The columns a descriptor's answer has, in the names the compiler gives them (`as`, else the field, else
 * `<field>_<bucket>`): the only columns a sort may name.
 */
export function outputColumnsOf(descriptor: DescriptorLike | null | undefined): string[] {
    const out: string[] = [];
    for (const g of descriptor?.groupBy || []) {
        if (!g?.field) continue;
        out.push(g.as || (g.bucket ? `${g.field}_${g.bucket}` : g.field));
    }
    for (const a of descriptor?.aggregates || []) if (a?.as) out.push(a.as);
    return out;
}

/** The descriptor with `sort` and `limit` added when they are set; untouched (same keys) when they are not. */
export function withSortLimit<T extends DescriptorLike>(
    descriptor: T,
    sort: DatasetSort | null | undefined,
    limit: number | null | undefined,
): T & { sort?: DatasetSort[]; limit?: number } {
    const out: T & { sort?: DatasetSort[]; limit?: number } = { ...descriptor };
    // A sort naming a column that is no longer in the answer would fail to compile: leave it out.
    if (sort?.field && outputColumnsOf(descriptor).includes(sort.field)) {
        out.sort = [{ field: sort.field, dir: sort.dir === 'desc' ? 'desc' : 'asc' }];
    }
    if (Number.isInteger(limit) && (limit as number) > 0) out.limit = limit as number;
    return out;
}
