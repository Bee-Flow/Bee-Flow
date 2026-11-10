/**
 * App Studio AI steps — the DATASET TOOLS (moved out of aiSteps.js unchanged).
 *
 * When an AI step's `datasets` binding names LARGE datasets (genome files),
 * the model gets ONE closed-over tool that queries bounded slices of exactly
 * those datasets — pre-authorized here: owner-scoped in the store, and
 * uploader-scoped against the person the step runs as (ctx.viewerId), so a
 * member's step can only hand the model her own file (appStudio/
 * datasetAccess.js). No dispatcher, no catalog: the closure IS the
 * authorization. The file itself never enters the prompt.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type Manifest = { id: string; name: string; metadata?: { build?: string } | null; variantCount?: number | null };
type ToolArgs = { dataset?: unknown; gene?: string; region?: string; rsid?: string; filterPass?: boolean; minQual?: unknown; limit?: unknown };
export type DatasetTool = { def: Obj; execute: (args?: ToolArgs) => Promise<Obj> };

const MAX_AI_STEP_DATASETS = 4;

const TOOL_PARAMETERS = {
    type: 'object',
    properties: {
        dataset: { type: 'string', description: 'Dataset name or id. Optional when only one dataset is available.' },
        gene: { type: 'string', description: 'Gene symbol, e.g. "BRCA1".' },
        region: { type: 'string', description: 'Region "chrom:start-end", e.g. "chr17:43044295-43125364".' },
        rsid: { type: 'string', description: 'dbSNP id, e.g. "rs1801133".' },
        filterPass: { type: 'boolean', description: 'Only rows with FILTER=PASS.' },
        minQual: { type: 'number', description: 'Minimum QUAL.' },
        limit: { type: 'number', description: 'Max rows (≤200, default 50).' },
    },
    additionalProperties: false,
};

/** The query tool over the resolved manifests. */
function queryTool(manifests: Manifest[]): DatasetTool['execute'] {
    const { datasetAdapter } = nodeRequire('../datasetQueryStep') as { datasetAdapter: (ds: Manifest) => unknown };
    const { queryRegion, DatasetQueryError } = nodeRequire('../../core/datasets/query') as {
        queryRegion: (adapter: unknown, q: Obj) => Promise<Obj>; DatasetQueryError: new (...a: unknown[]) => Error;
    };
    const byKey = new Map<string, Manifest>();
    for (const ds of manifests) {
        byKey.set(ds.id, ds);
        if (!byKey.has(ds.name)) byKey.set(ds.name, ds);
    }
    return async (args: ToolArgs = {}) => {
        const ds = args.dataset ? byKey.get(String(args.dataset)) : manifests[0];
        if (!ds) return { error: `Unknown dataset "${args.dataset}". Available: ${manifests.map((m) => m.name).join(', ')}` };
        try {
            const r = await queryRegion(datasetAdapter(ds), {
                gene: args.gene || undefined,
                region: args.region || undefined,
                rsid: args.rsid || undefined,
                filterPass: args.filterPass === true,
                minQual: typeof args.minQual === 'number' ? args.minQual : undefined,
                limit: typeof args.limit === 'number' ? args.limit : undefined,
            });
            return {
                rows: r.rows, rowCount: r.rowCount, truncated: r.truncated, notes: r.notes,
                gene: r.gene, region: r.region, build: r.build,
            };
        } catch (e) {
            if (e instanceof DatasetQueryError || (e as { status?: unknown }).status === 400) return { error: (e as Error).message };
            throw e;
        }
    };
}

/**
 * The step's dataset tools and the prompt line that names them; none without a `datasets` binding.
 * `resolve` is the step's binding resolver (shared.resolveBinding over its scope).
 */
export async function buildDatasetTools(app: unknown, step: { datasets?: unknown }, ctx: { viewerId?: string | null }, resolve: (b: unknown) => unknown): Promise<{ tools: DatasetTool[]; promptLine: string }> {
    if (step.datasets === undefined || step.datasets === null) return { tools: [], promptLine: '' };
    const { resolveReadyDataset } = nodeRequire('../datasetQueryStep') as { resolveReadyDataset: (app: unknown, entry: unknown, viewerId: unknown) => Promise<Manifest> };

    const raw = resolve(step.datasets);
    const list = (Array.isArray(raw) ? raw : (raw ? [raw] : [])).slice(0, MAX_AI_STEP_DATASETS);
    if (!list.length) return { tools: [], promptLine: '' };

    const manifests: Manifest[] = [];
    for (const entry of list) manifests.push(await resolveReadyDataset(app, entry, ctx.viewerId));

    const describe = manifests
        .map((ds) => `"${ds.name}" (${ds.metadata?.build || 'unknown build'}, ${ds.variantCount ?? '?'} variants)`)
        .join('; ');

    const def = {
        type: 'function',
        function: {
            name: 'query_genome_dataset',
            description: `Read a bounded slice of the user's genome dataset(s): ${describe}. Exactly ONE of gene, region or rsid selects the slice. Results are capped — narrow the span rather than paging.`,
            parameters: TOOL_PARAMETERS,
        },
    };
    return {
        tools: [{ def, execute: queryTool(manifests) }],
        promptLine: `\n\nGenome datasets available through the query_genome_dataset tool: ${describe}. Query only the slices you need.`,
    };
}
