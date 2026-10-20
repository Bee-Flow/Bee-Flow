// @typecheck
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
const { makeAutomationAccess } = require('../../automation/access');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { tableLimits } = require('../../core/automationRunner/tables/limits');
const { TABLE_ID_RE, COLUMN_TYPES } = require('../../core/automationRunner/tables/handle');
const { serializeCell } = require('../../core/automationRunner/tables/tableCodec');
const { makeJourneyReader } = require('./runJourney');
const log = require('../../telemetry/log');

const MAX_PREVIEW_ROWS = 50;
const KEY_SAMPLE_ROWS = 1000;
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
    rows: z.array(z.record(z.string(), z.unknown())).max(HARD_ROWS),
    columns: z.array(ColumnShape).max(2000).optional(),
}).strict();
const SourceShape = z.union([RunRef, InlineRows]);
const Body = z.object({
    source: SourceShape,
    ops: z.array(z.unknown()).max(HARD_OPS),
    upToOpId: z.string().max(100).optional(),
    joinSources: z.record(z.string().max(100), SourceShape).optional(),
    limit: z.number().int().min(1).max(MAX_PREVIEW_ROWS).optional(),
}).strict();

const isRunRef = (s) => !!s && typeof s.tableId === 'string';

/** Inline rows as a table: given columns, or the union of the keys of the first rows (type 'mixed'). */
function inlineTable(src, limits) {
    const cap = limits.previewInputRows;
    const capped = cap > 0 && src.rows.length > cap;
    const rows = capped ? src.rows.slice(0, cap) : src.rows;
    let columns = src.columns;
    if (!columns) {
        const seen = new Set();
        for (const r of rows.slice(0, KEY_SAMPLE_ROWS)) for (const k of Object.keys(r || {})) if (k.length <= 200) seen.add(k);
        let keys = [...seen];
        if (limits.maxColumns > 0) keys = keys.slice(0, limits.maxColumns);
        columns = keys.map(k => ({ key: k, label: k, type: 'mixed' }));
    }
    const keys = columns.map(c => c.key);
    const clean = rows.map(r => Object.fromEntries(keys.map(k => [k, serializeCell(r ? r[k] : null)])));
    return { columns, rows: clean, inputCapped: capped };
}

/** Where in the step an engine error points, in the finding's relative-path form. */
function pathOfError(e, ops) {
    if (!e.opId) return '';
    const i = ops.findIndex(op => op && op.id === e.opId);
    if (i < 0) return 'ops';
    return `ops[${i}]${e.field ? `.${e.field}` : ''}`;
}

const isMissingObject = (e) => !!e && (e.name === 'NoSuchKey' || e.code === 'ENOENT' || e.code === 'NoSuchKey');

/**
 * @param {object} [overrides]
 * @param {object} [overrides.store]       automationStore surface
 * @param {object} [overrides.tableStore]  { readTablePage }
 * @param {object} [overrides.storage]     unused; the preview never writes storage
 * @param {object} [overrides.spec]        core/automationModel/tableOps/spec
 * @param {object} [overrides.engine]      core/automationRunner/tables/ops
 * @param {object} [overrides.groupPolicy] core/automationRunner/tables/groupPolicy
 * @param {(automation: any) => Promise<Record<string, unknown>>} [overrides.runVarsFor]
 * @param {() => ReturnType<typeof tableLimits>} [overrides.limits]
 * @param {(id: string) => Promise<any>} [overrides.getUser]
 * @param {(userId: string, permission: string, session?: any) => Promise<boolean>} [overrides.hasPermission]
 */
function makeTablePreviewRouter(overrides = {}) {
    const router = express.Router();
    const store = () => overrides.store || require('../../stores/automationStore');
    const tables = () => overrides.tableStore || require('../../core/automationRunner/tables/tableStore');
    const limitsNow = () => (overrides.limits ? overrides.limits() : tableLimits());
    const access = makeAutomationAccess({
        store: overrides.store,
        ...(overrides.getUser ? { getUser: overrides.getUser } : {}),
        ...(overrides.hasPermission ? { hasPermission: overrides.hasPermission } : {}),
    });
    const journey = makeJourneyReader({ store, access, what: 'see its tables' });

    let limiter = { rpm: 0, run: null };
    const previewLimiter = (req, res, next) => {
        const rpm = limitsNow().previewRpm;
        if (rpm <= 0) return next();
        if (limiter.rpm !== rpm) limiter = { rpm, run: perUserRateLimit({ windowMs: 60_000, max: rpm }) };
        return limiter.run(req, res, next);
    };

    /** A table of one of this automation's runs, capped; null after a 403 was written. */
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

    /** One source of the request as columns and rows; null after a 403 was written. */
    const resolveSource = (req, res, src, limits) => (isRunRef(src)
        ? runTable(req, res, src, limits)
        : Promise.resolve(inlineTable(src, limits)));

    router.post('/:id/table-preview', previewLimiter, validate({ body: Body }), async (req, res) => {
        const automation = await store().getAutomation(req.params.id);
        if (!automation) throw new HttpError(404, 'automation_not_found', 'Not found');
        const me = req.session.user.id;
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

        const input = await resolveSource(req, res, body.source, limits);
        if (!input) return undefined;
        const joins = {};
        for (const [opId, src] of Object.entries(body.joinSources || {})) {
            const t = await resolveSource(req, res, src, limits);
            if (!t) return undefined;
            joins[opId] = t;
        }

        const step = spec.normalizeTableStep({ source: null, ops: body.ops });
        // The preview supplies the input itself, so a missing step-level source is not a finding here.
        const findings = (spec.validateTableStep(step, { columns: input.columns }) || [])
            .filter(f => !(typeof f.path === 'string' && /^source(\b|\.|\[|$)/.test(f.path)));
        if (findings.some(f => f.severity === 'error')) {
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

        const joinOps = step.ops.filter(o => o && o.op === 'join');

        /** The sample the request supplied for a join, by the operation that asks for it. */
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
                ...findings.filter(f => f.severity === 'warning').map(f => f.message),
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
