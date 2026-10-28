/** @typedef {import('express-serve-static-core').NextFunction} NextFunction */
// @typecheck strict
/**
 * The builder's live preview of a `table` step:
 *
 *   POST /:id/table-preview
 *
 * Runs the step's operations on a sample of the input and answers with the
 * first rows, the per-operation result and the findings, so the form can show
 * what a change does while it is being typed. It is a DRY evaluation: nothing
 * is written to storage, no other step type is called, and `rulesFrom` is not
 * resolved (the engine warns `rules_from_runtime`).
 *
 * The input is either a table a run of THIS automation wrote (checked through
 * the same journey read as every other run read) or rows sent in the request.
 * It is capped at AUTOMATION_TABLE_PREVIEW_INPUT_ROWS rows and `inputCapped`
 * says when that cut something. The caller needs the edit role.
 *
 * The operation spec and the engine are required lazily, inside the handler,
 * so this router loads without them.
 */

'use strict';

const express = require('express');
const { z } = require('../../utils/zod');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { TABLE_ID_RE, COLUMN_TYPES } = require('../../core/automationRunner/tables/handle');
const { listToTable } = require('../../core/automationRunner/tables/listSource');
const { tableRouterDeps } = require('./tableRouterDeps');
const log = require('../../telemetry/log');
const { sessionUser } = require('../../core/http/sessionUser');

const MAX_PREVIEW_ROWS = 50;
const HARD_ROWS = 100_000;
const HARD_OPS = 1000;
const notFound = () => new HttpError(404, 'run_table_not_found', 'Not found');

const RunRef = z.object({
    runId: z.string().min(1).max(100),
    tableId: z.string().regex(TABLE_ID_RE, 'tableId is not a table id'),
}).strict();
const ColumnShape = z.object({
    key: z.string().min(1).max(200),
    label: z.string().max(200),
    type: z.enum(COLUMN_TYPES),
}).strict();
const InlineRows = z.object({
    rows: z.array(z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())])).max(HARD_ROWS),
    columns: z.array(ColumnShape).max(2000).optional(),
}).strict();
// A Code step's output envelope, with the list under `result`.
const CodeResult = z.object({
    result: z.union([
        z.array(z.record(z.string(), z.unknown())).max(HARD_ROWS),
        InlineRows,
    ]),
    logs: z.array(z.unknown()).optional(),
    httpCalls: z.array(z.unknown()).optional(),
}).strict();
const SourceShape = z.union([RunRef, InlineRows, CodeResult]);
const Body = z.object({
    source: SourceShape,
    ops: z.array(z.unknown()).max(HARD_OPS),
    upToOpId: z.string().max(100).optional(),
    joinSources: z.record(z.string().max(100), SourceShape).optional(),
    limit: z.number().int().min(1).max(MAX_PREVIEW_ROWS).optional(),
}).strict();

/** @param {Record<string, unknown>} s */
const isRunRef = (s) => !!s && typeof s.tableId === 'string';

/**
 * A source that is not a run table, as columns and rows: the same list shapes
 * the step itself accepts (a list of records, `{ rows }`, `{ columns, rows }`,
 * a Code step's `{ result }`), read by `listToTable` so the preview types the
 * columns exactly as a run would. Capped at `previewInputRows`.
 * @param {unknown} src
 * @param {ReturnType<typeof import('../../core/automationRunner/tables/limits').tableLimits>} limits
 */
function inlineTable(src, limits) {
    const cap = limits.previewInputRows;
    const listed = listToTable(src, cap > 0 ? { sample: cap } : {});
    if (!listed) {
        throw Object.assign(new Error('The sample is not a list of rows. Send rows, or { columns, rows }.'), { errorClass: 'table_source_invalid', field: 'source' });
    }
    let { columns, rows } = listed;
    if (limits.maxColumns > 0 && columns.length > limits.maxColumns) {
        columns = columns.slice(0, limits.maxColumns);
        const keys = columns.map(c => c.key);
        rows = rows.map(r => Object.fromEntries(keys.map(k => [k, r[k]])));
    }
    return { columns, rows, inputCapped: listed.truncated };
}

/**
 * Where in the step an engine error points, in the finding's relative-path form.
 * @param {{ opId?: string | null, field?: string }} e
 * @param {Array<{ id?: string } | null>} ops
 */
function pathOfError(e, ops) {
    if (!e.opId) return '';
    const i = ops.findIndex(op => op && op.id === e.opId);
    if (i < 0) return 'ops';
    return `ops[${i}]${e.field ? `.${e.field}` : ''}`;
}

/** @param {{ name?: string, code?: string } | null | undefined} e */
const isMissingObject = (e) => !!e && (e.name === 'NoSuchKey' || e.code === 'ENOENT' || e.code === 'NoSuchKey');

/**
 * @param {object} [overrides]
 * @param {any} [overrides.store]       automationStore surface; typed, its nullable rows do not fit the handlers
 * @param {Pick<typeof import('../../core/automationRunner/tables/tableStore'), 'readTablePage'>} [overrides.tableStore]
 * @param {typeof import('../../stores/storageStore')} [overrides.storage]  unused; the preview never writes storage
 * @param {any} [overrides.spec]        core/automationModel/tableOps/spec; typed, its lazily defined validateTableStep is missing from the module type
 * @param {typeof import('../../core/automationRunner/tables/ops')} [overrides.engine]
 * @param {typeof import('../../core/automationRunner/tables/groupPolicy')} [overrides.groupPolicy]
 * @param {(automation: any) => Promise<Record<string, unknown>>} [overrides.runVarsFor]
 * @param {() => ReturnType<typeof import('../../core/automationRunner/tables/limits').tableLimits>} [overrides.limits]
 * @param {(id: string) => Promise<any>} [overrides.getUser]
 * @param {(userId: string, permission: string, session?: any) => Promise<boolean>} [overrides.hasPermission]
 */
function makeTablePreviewRouter(overrides = {}) {
    const router = express.Router();
    const { store, tables, limitsNow, access, journey } = tableRouterDeps(overrides);

    /** @type {{ rpm: number, run: ReturnType<typeof perUserRateLimit> } | null} */
    let limiter = null;
    /**
     * @type {import('express').RequestHandler}
     * @param {NextFunction} next
     */
    const previewLimiter = (req, res, next) => {
        const rpm = limitsNow().previewRpm;
        if (rpm <= 0) return next();
        if (!limiter || limiter.rpm !== rpm) limiter = { rpm, run: perUserRateLimit({ windowMs: 60_000, max: rpm }) };

        return limiter.run(req, res, next);
    };

    /**
     * A table of one of this automation's runs, capped; null after a 403 was written.
     * @param {import('express').Request<{ id: string }>} req
     * @param {import('express').Response} res
     * @param {import('zod').infer<typeof RunRef>} ref
     * @param {ReturnType<typeof import('../../core/automationRunner/tables/limits').tableLimits>} limits
     */
    async function runTable(req, res, ref, limits) {
        const found = await journey(req, res, ref.runId);
        if (!found) return null;
        if (found.run.automationId !== req.params.id) throw new HttpError(404, 'run_not_found', 'Not found');
        const row = await store().getRunTableForRuns(ref.tableId, found.runIds);
        if (!row || row.automationId !== req.params.id) throw notFound();
        const cap = limits.previewInputRows;
        let page;
        try {
            page = await tables().readTablePage(row, { offset: 0, limit: cap > 0 ? cap : Number.MAX_SAFE_INTEGER });
        } catch (e) {
            if (isMissingObject(e)) throw notFound();
            throw e;
        }
        return { columns: row.columns, rows: page.rows, inputCapped: !!page.hasMore };
    }

    /**
     * One source of the request as columns and rows; null after a 403 was written.
     * @param {import('express').Request<{ id: string }>} req
     * @param {import('express').Response} res
     * @param {import('zod').infer<typeof SourceShape>} src
     * @param {ReturnType<typeof import('../../core/automationRunner/tables/limits').tableLimits>} limits
     */
    const resolveSource = (req, res, src, limits) => (isRunRef(src)
        ? runTable(req, res, /** @type {import('zod').infer<typeof RunRef>} */ (src), limits)
        : Promise.resolve(inlineTable(src, limits)));

    router.post('/:id/table-preview', previewLimiter, validate({ body: Body }), async (/** @type {import('express').Request<{ id: string }>} */ req, res) => {
        const automation = await store().getAutomation(req.params.id);
        if (!automation) throw new HttpError(404, 'automation_not_found', 'Not found');
        const me = sessionUser(req).id;
        const { role } = await access.roleFor(automation, me, { session: req.session });
        if (!role) throw new HttpError(404, 'automation_not_found', 'Not found');
        if (!await access.guard(req, res, automation, 'edit')) return undefined;

        const body = req.body;
        const limits = limitsNow();
        const spec = overrides.spec || require('../../core/automationModel/tableOps/spec');

        if (limits.maxOps > 0 && body.ops.length > limits.maxOps) {
            return res.json({
                ok: false,
                findings: [{ code: 'table.too_many_ops', severity: 'error', path: 'ops', message: `A table step can have at most ${limits.maxOps} operations.` }],
                opResults: [],
            });
        }

        let input;
        /** @type {Record<string, NonNullable<Awaited<ReturnType<typeof resolveSource>>>>} */
        const joins = {};
        try {
            input = await resolveSource(req, res, body.source, limits);
            if (!input) return undefined;
            for (const [opId, src] of Object.entries(body.joinSources || {})) {
                const t = await resolveSource(req, res, src, limits);
                if (!t) return undefined;
                joins[opId] = t;
            }
        } catch (e) {
            // A sample that cannot be a table is a finding on the source, not a 500.
            if (!e || e.errorClass !== 'table_source_invalid') throw e;
            return res.json({ ok: false, findings: [{ code: e.errorClass, severity: 'error', path: 'source', message: e.message }], opResults: [] });
        }

        const step = spec.normalizeTableStep({ source: null, ops: body.ops });
        // The preview supplies the input itself, so a missing step-level source is not a finding here.
        const findings = (spec.validateTableStep(step, { columns: input.columns }) || [])
            .filter((/** @type {{ path?: unknown, severity?: string, message?: string }} */ f) => !(typeof f.path === 'string' && /^source(\b|\.|\[|$)/.test(f.path)));
        if (findings.some((/** @type {{ severity?: string }} */ f) => f.severity === 'error')) {
            return res.json({ ok: false, findings, opResults: [] });
        }

        const engine = overrides.engine || require('../../core/automationRunner/tables/ops');
        const policy = overrides.groupPolicy || require('../../core/automationRunner/tables/groupPolicy');
        const runVarsFor = overrides.runVarsFor || require('../../core/automationRunner/stageVars').runVarsFor;
        let minGroupFloor = limits.minGroupFloor;
        try {
            const orgId = await access.organisationOf(automation);
            minGroupFloor = await policy.minGroupFloorFor(orgId);
        } catch (e) {
            log.warn(`[automation/tablePreview] group policy unreadable, using the default floor: ${e.message}`);
        }
        const vars = await runVarsFor(automation);

        const joinOps = step.ops.filter((/** @type {{ op?: string, id?: string } | null} */ o) => o && o.op === 'join');

        /** The sample the request supplied for a join, by the operation that asks for it. */
        /**
         * @param {unknown} binding
         * @param {string | null} [opId]
         */
        const resolveTable = async (binding, opId) => {
            const keys = Object.keys(joins);
            // A lone source stands in only when the step has a single join: with two, each must be asked for by its own id.
            const hit = (opId && joins[opId]) || (keys.length === 1 && joinOps.length === 1 && (!opId || joinOps[0].id === opId) ? joins[keys[0]] : null);
            if (hit) return { columns: hit.columns, rows: hit.rows };
            if (Array.isArray(binding)) {
                const t = inlineTable({ rows: binding.filter(r => r && typeof r === 'object') }, limits);
                return { columns: t.columns, rows: t.rows };
            }
            throw Object.assign(
                new Error('The preview has no sample table for this join. Pick a run table to preview it with.'),
                { errorClass: 'table_op_invalid', opId: opId || null, field: 'with' },
            );
        };

        const limit = Math.min(MAX_PREVIEW_ROWS, body.limit || limits.previewRows || 20);
        let result;
        try {
            result = await engine.runTableOps({
                source: { columns: input.columns, rows: async function* rows() { for (const r of input.rows) yield r; }, provenance: null },
                ops: step.ops,
                runState: { vars },
                resolveTable,
                limits,
                minGroupFloor,
                mode: 'preview',
                upToOpId: body.upToOpId,
            });
            const out = [];
            let rowCount = 0;
            for await (const r of result.rows()) {
                if (out.length < limit) out.push(r);
                rowCount += 1;
            }
            const warnings = [...new Set([
                ...(result.warnings || []),
                ...findings.filter((/** @type {{ severity?: string }} */ f) => f.severity === 'warning').map((/** @type {{ message?: string }} */ f) => f.message),
            ])];
            return res.json({
                ok: true,
                columns: result.columns,
                rows: out,
                rowCount,
                inputRows: input.rows.length,
                inputCapped: input.inputCapped,
                description: result.description || null,
                segments: result.segments || null,
                opResults: result.opStats || [],
                warnings,
            });
        } catch (e) {
            if (!e || !e.errorClass) throw e;
            return res.json({
                ok: false,
                findings: [...findings, {
                    code: e.errorClass,
                    severity: 'error',
                    path: pathOfError(e, step.ops || []),
                    message: e.message,
                    ...(e.hint ? { hint: e.hint } : {}),
                }],
                opResults: e.opStats || [],
            });
        }
    });

    return router;
}

module.exports = { makeTablePreviewRouter, Body, inlineTable };
