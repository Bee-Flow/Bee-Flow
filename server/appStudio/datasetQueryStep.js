/**
 * dataset_query — the server step that answers "which variants sit in this
 * slice of my genome file" without the file ever being loaded whole.
 *
 * Own module on the fileIntake pattern: the executor lends it the binding /
 * scope / write machinery as an argument, so the two never require each other
 * at load time.
 *
 * Security shape (mirrors attachments):
 *   - The dataset binding resolves from CLIENT-supplied values, so the id is
 *     untrusted. Resolution is OWNER-scoped in the store — a forged foreign id
 *     is indistinguishable from a missing one.
 *   - And UPLOADER-scoped here: the step runs as the person clicking
 *     (ctx.viewerId), and a genome file answers to the person who uploaded it
 *     and nobody else, the app's owner included (appStudio/datasetAccess.js).
 *     Another member's id is "Dataset not found", exactly like a forged one,
 *     and it is refused before a byte of the file is read.
 *   - Only status 'ready' datasets are queryable ('structural' AV verdict —
 *     the artifact is our own re-encoding of parsed fields).
 *   - The result is bounded by core/datasets/query (≤200 rows, char budget,
 *     block window) and truncation is always reported.
 */

'use strict';

const datasetFileStore = require('../stores/datasetFileStore');
const storageStore = require('../stores/storageStore');
const blockIndex = require('../core/datasets/blockIndex');
const rsidIndex = require('../core/datasets/rsidIndex');
const { queryRegion, DatasetQueryError } = require('../core/datasets/query');
const stepDataSource = require('./stepDataSource');
const { DATASET_QUERY_OUTPUTS } = require('./validate');
const { isUploaderOf } = require('./datasetAccess');

// Deserialized block indexes are ≤8 MB each and immutable once ready — a tiny
// LRU (Map insertion order) keyed on datasetId+readyAt keeps repeat queries
// from re-downloading the index every click.
const INDEX_CACHE_MAX = parseInt(process.env.DATASET_INDEX_CACHE, 10) || 4;
const indexCache = new Map();

async function loadIndexCached(ds) {
    const key = `${ds.id}:${ds.readyAt ? new Date(ds.readyAt).getTime() : 0}`;
    if (indexCache.has(key)) {
        const idx = indexCache.get(key);
        indexCache.delete(key);
        indexCache.set(key, idx); // LRU bump
        return idx;
    }
    const { stream } = await storageStore.streamFile(ds.indexKey);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const idx = blockIndex.deserialize(Buffer.concat(chunks));
    indexCache.set(key, idx);
    while (indexCache.size > INDEX_CACHE_MAX) indexCache.delete(indexCache.keys().next().value);
    return idx;
}

/** Normalize whatever the binding resolved to into a dataset id, or null. */
function datasetIdOf(value) {
    let v = value;
    if (typeof v === 'string') {
        const s = v.trim();
        if (s.startsWith('{')) { try { v = JSON.parse(s); } catch { return null; } }
        else return s || null;
    }
    if (v && typeof v === 'object') {
        if (typeof v.datasetId === 'string') return v.datasetId;
        if (typeof v.id === 'string' && (v.kind === 'studio_dataset' || v.kind === undefined)) return v.id;
    }
    return null;
}

/** The queryable adapter core/datasets/query takes, over one ready manifest. */
function datasetAdapter(ds) {
    const md = ds.metadata || {};
    return {
        build: md.build || null,
        samples: Array.isArray(md.samples) ? md.samples : [],
        loadIndex: () => loadIndexCached(ds),
        readRange: async (start, endExclusive) => {
            const { stream } = await storageStore.streamFile(ds.dataKey, { range: { start, end: endExclusive - 1 } });
            const chunks = [];
            for await (const c of stream) chunks.push(c);
            return Buffer.concat(chunks);
        },
        readRsidShard: async (shard) => {
            if (!ds.rsidPrefix) return null; // pre-index dataset: no rsID lookups
            try {
                const key = storageStore.buildStudioAppDatasetKey(ds.ownerId, ds.appId, ds.id, `rsid/${rsidIndex.shardName(shard)}.bin`);
                const { stream } = await storageStore.streamFile(key);
                const chunks = [];
                for await (const c of stream) chunks.push(c);
                return Buffer.concat(chunks);
            } catch (e) {
                // An absent shard just means "no rs numbers hashed here".
                if (e?.name === 'NoSuchKey') return Buffer.alloc(0);
                throw e;
            }
        },
    };
}

/**
 * Resolve + authorize the dataset named by a step/tool argument. Shared with
 * aiRuntime's query_genome_dataset tool so the two paths cannot drift.
 * @param {object} app
 * @param {*} rawValue what the binding resolved to (a descriptor or an id)
 * @param {string|null|undefined} actorId the person the step runs as (ctx.viewerId);
 *   only the dataset's uploader resolves it, and naming nobody resolves nothing
 * @returns {Promise<object>} the manifest row — throws a client-safe error otherwise.
 */
async function resolveReadyDataset(app, rawValue, actorId) {
    const id = datasetIdOf(rawValue);
    if (!id) {
        const e = new Error('The dataset is not set — bind it to an input_dataset value or a dataset id');
        e.status = 400;
        throw e;
    }
    const ds = await datasetFileStore.getDataset(id, app.id, app.userId);
    if (!ds || !isUploaderOf(ds, actorId)) {
        // Owner-scoped in the store, uploader-scoped here: a foreign id and
        // another member's file are the same answer as a missing one.
        const e = new Error('Dataset not found');
        e.status = 400;
        throw e;
    }
    if (ds.status !== 'ready') {
        const e = new Error(ds.status === 'failed'
            ? `This dataset failed to ingest (${ds.error || 'unknown reason'}) — upload it again`
            : `This dataset is still ${ds.status} — wait until it is ready`);
        e.status = 400;
        throw e;
    }
    return ds;
}

/** One row's writeTo output vocabulary (see validate.DATASET_QUERY_OUTPUTS). */
function outputsFor(row, result) {
    return {
        chrom: row.chrom,
        pos: row.pos,
        id: row.id,
        ref: row.ref,
        alt: row.alt,
        qual: row.qual,
        filter: row.filter,
        info: row.info && Object.keys(row.info).length ? JSON.stringify(row.info) : null,
        variant_key: `${row.chrom}:${row.pos}:${row.ref}>${row.alt}`,
        gene: result.gene,
        region: result.region ? `${result.region.chrom}:${result.region.start}-${result.region.end}` : null,
    };
}

async function datasetQueryStep(app, model, step, ctx, helpers) {
    const { resolveBinding, buildServerScope, writeViewer, findTable, writeRecord } = helpers;
    const scope = buildServerScope(ctx);
    const resolve = (b) => (b === undefined || b === null ? null : resolveBinding(b, ctx, scope));

    const ds = await resolveReadyDataset(app, resolve(step.dataset), ctx.viewerId);

    // Selectors resolve through bindings, so re-check arity on the RESOLVED
    // values — an authored gene binding can legitimately resolve to null (an
    // empty form field), which must be a clear error, not a whole-file query.
    const gene = resolve(step.gene);
    const region = resolve(step.region);
    const rsid = resolve(step.rsid);
    const present = [gene, region, rsid].filter((v) => v !== null && v !== '').length;
    if (present !== 1) {
        const e = new Error(present === 0
            ? 'The query needs a gene, region or rsID — the bound value is empty'
            : 'The query sets more than one of gene/region/rsid');
        e.status = 400;
        throw e;
    }

    let result;
    try {
        result = await queryRegion(datasetAdapter(ds), {
            gene: gene || undefined,
            region: region || undefined,
            rsid: rsid || undefined,
            filterPass: step.filterPass === true,
            minQual: typeof step.minQual === 'number' ? step.minQual : undefined,
            limit: typeof step.limit === 'number' ? step.limit : undefined,
            includeGenotypes: step.includeGenotypes === true,
        });
    } catch (e) {
        if (e instanceof DatasetQueryError) {
            const err = new Error(e.message);
            err.status = 400;
            throw err;
        }
        throw e;
    }

    // Optional writeTo — one row per variant, fileIntake's upsert discipline.
    let written = 0;
    if (step.writeTo && typeof step.writeTo === 'object' && step.writeTo.tableId && result.rows.length) {
        const table = findTable(model, step.writeTo.tableId);
        if (!table) { const e = new Error('writeTo names a table this app does not have'); e.status = 400; throw e; }
        const mapping = (step.writeTo.mapping && typeof step.writeTo.mapping === 'object') ? step.writeTo.mapping : {};
        const hasField = (t, col) => (t.fields || []).some((f) => f && f.key === col);
        const constants = {};
        for (const [col, binding] of Object.entries(step.writeTo.constants || {})) {
            if (hasField(table, col)) constants[col] = resolve(binding);
        }
        const upsertCol = typeof step.writeTo.upsertOn === 'string' && hasField(table, step.writeTo.upsertOn)
            ? step.writeTo.upsertOn : null;

        for (const row of result.rows) {
            const outputs = outputsFor(row, result);
            const values = {};
            for (const [col, out] of Object.entries(mapping)) {
                if (!hasField(table, col)) continue;
                if (typeof out === 'string' && DATASET_QUERY_OUTPUTS.includes(out)) {
                    values[col] = Object.prototype.hasOwnProperty.call(outputs, out) ? outputs[out] : null;
                }
            }
            Object.assign(values, constants);

            let existingId;
            if (upsertCol && values[upsertCol] != null) {
                const existing = await stepDataSource.resolveDataBinding(app, model, {
                    kind: 'record', tableId: table.id,
                    filter: [{ field: upsertCol, op: 'eq', value: values[upsertCol], required: true }],
                }, { viewer: writeViewer(ctx), role: ctx.role ?? null, resolveValue: resolve });
                existingId = existing && existing.id ? existing.id : undefined;
            }
            await writeRecord(app, model, table, values, { viewer: writeViewer(ctx), recordId: existingId });
            written += 1;
        }
    }

    const summary = step.resultDetail === 'summary';
    return {
        ok: true,
        result: {
            ...(summary ? {} : { rows: result.rows }),
            rowCount: result.rowCount,
            returned: result.rows.length,
            truncated: result.truncated,
            notes: result.notes,
            region: result.region,
            gene: result.gene,
            rsid: result.rsid,
            build: result.build,
            datasetId: ds.id,
            datasetName: ds.name,
            written,
        },
    };
}

module.exports = { datasetQueryStep, resolveReadyDataset, datasetAdapter, _internals: { datasetIdOf, outputsFor, indexCache } };
