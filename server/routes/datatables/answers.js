/**
 * A form's answers (managed_kind = 'form_answers').
 *
 * Thin handlers over automation/formAnswers: the dashboard's numbers, the
 * generic aggregate, the one DROP the feature allows (a retired question's
 * column, by the owner's hand), and "keep the answers, forget the form".
 * Reads are gated by the table's grade ladder — the same ladder that gates its
 * rows — so sharing the table IS sharing the dashboard.
 */

'use strict';

const datatableStore = require('../../stores/datatableStore');
const { isDefinitionManagedKind } = require('../../core/dataEngine/dataModel/managedTables');
const { requireDatatableGrade, requireManageForOrgScope, metaAndFilter } = require('./grade');
const { answerDatatableError, confirmedBreaking, breakingColumnUsage } = require('./refusals');
const { publicTable, publicSource } = require('./projection');
const { readFilters } = require('./rowDescriptor');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const { worded, bodyOf, ConfirmBreakingQuery } = require('./schemas');
const log = require('../../telemetry/log');

// ── What the dashboard may ask for ──────────────────────────────────
//
// A calendar day, `YYYY-MM-DD`, and strictly so. summary.resolveRange tests
// the value against that shape and falls back to "the last 30 days" when it
// does not match, so `?from=01-03-2026` — a date as most of Europe writes one
// — answered a period nobody asked for. Strict on the query for the same
// reason: `?form=2026-01-01` was dropped, with the same result.
const DAY_TEXT = 'A period runs between two calendar days, written 2026-01-31.';
const day = () => worded(DAY_TEXT).trim().regex(/^\d{4}-\d{2}-\d{2}$/, DAY_TEXT).optional();
const SummaryQuery = z.object({ from: day(), to: day() }).strict();

// Nothing at all. `release` is a verb on the table in the path — a body key
// would be a caller expecting it to do something narrower.
const NOTHING = bodyOf({});
const NO_QUERY = z.object({}).strict();

function requireAnswersTable(req, res, next) {
    if (!isDefinitionManagedKind(req.datatable.managedKind)) return res.status(404).json({ error: 'Not found' });
    next();
}

/** The routine behind an answers table, as the dashboard names it. */
async function formOf(req) {
    const automationId = req.datatable.source?.automationId || null;
    if (!automationId) return null;
    try {
        const automationStore = require('../../stores/automationStore');
        const a = await automationStore.getAutomation(automationId);
        if (!a) return { automationId, title: null, live: false, url: null, linked: false, mine: false };
        const pages = await automationStore.getFormPagesForAutomation(automationId);
        const page = (pages || []).find(p => !p.triggerStepId) || (pages || [])[0] || null;
        return {
            automationId,
            title: a.definition?.trigger?.form?.title || a.title || null,
            live: !!a.isActive,
            // The link is a credential: only somebody who may open the form
            // (an organisation member) gets to see it.
            url: page && (req.datatablePrincipal.orgId && a.organizationId === req.datatablePrincipal.orgId
                || a.userId === req.datatablePrincipal.userId) ? `/f/${page.id}` : null,
            linked: req.datatable.source.linked !== false,
            mine: a.userId === req.datatablePrincipal.userId,
        };
    } catch (e) {
        log.warn('[datatables] answers form lookup failed:', e.message);
        return { automationId, title: null, live: false, url: null, linked: req.datatable.source.linked !== false, mine: false };
    }
}

function register(router) {
    router.get('/:id/answers/summary', requireDatatableGrade('viewer'), requireAnswersTable,
        validate({ query: SummaryQuery }), async (req, res) => {
        try {
            const { meta, filter } = await metaAndFilter(req, 'read');
            const formAnswers = require('../../automation/formAnswers');
            const summary = await formAnswers.summary.answersSummary({
                table: req.datatable, meta, filter, scopeKey: req.datatableScopeKey,
                range: { from: req.query.from, to: req.query.to },
                lookupUsers: (ids) => require('../../stores/userStore').getUserAvatarsByIds(ids),
            });
            const form = await formOf(req);
            res.json({ ...summary, form });
        } catch (e) {
            if (answerDatatableError(res, e, req.datatableScope)) return;
            log.error('[datatables] answers summary failed:', e.message);
            res.status(500).json({ error: 'Could not read the answers' });
        }
    });

    /**
     * LEFT OPEN — deliberately, and the reason is where the check lives.
     *
     * The aggregate body is a descriptor whose every field key is resolved
     * against THIS table's own declared column list, whose functions come from
     * dataModel.AGG_FNS and whose buckets come from DATE_BUCKETS — and that
     * resolution needs the table's meta, which only exists inside the handler.
     * readAggregateDescriptor (automation/formAnswers/summary.js) is that
     * check and it throws a 400 by name. A zod schema in front could only
     * restate the shape and would have to be kept in step with the compiler's
     * vocabulary in two places.
     */
    router.post('/:id/aggregate', requireDatatableGrade('viewer'), async (req, res) => {
        try {
            const { meta, filter } = await metaAndFilter(req, 'read');
            const formAnswers = require('../../automation/formAnswers');
            const descriptor = formAnswers.summary.readAggregateDescriptor(meta, req.body, { readFilters });
            const out = await formAnswers.summary.runAggregate({ meta, filter, scopeKey: req.datatableScopeKey, descriptor });
            res.json(out);
        } catch (e) {
            if (answerDatatableError(res, e, req.datatableScope)) return;
            log.error('[datatables] aggregate failed:', e.message);
            res.status(500).json({ error: 'Could not compute that' });
        }
    });

    // The ONE drop this feature allows, and the one route whose confirmation
    // never arrived: the Studio sends `?confirmBreaking=1` here, which
    // confirmedBreaking used to read as "no". See refusals.js.
    router.delete('/:id/answers/columns/:fieldId',
        requireDatatableGrade('owner'),
        requireManageForOrgScope(),
        requireAnswersTable,
        validate({ query: ConfirmBreakingQuery }),
        async (req, res) => {
            try {
                const entry = req.datatable.source?.columnMap?.[req.params.fieldId];
                if (!entry) return res.status(404).json({ error: 'No such column', code: 'unknown_field' });
                if (!entry.retired) {
                    return res.status(409).json({
                        error: 'That column is a question the form still asks — remove the question from the form first',
                        code: 'column_live',
                    });
                }
                const meta = await datatableStore.getTableMeta(req.datatableScope, req.datatable.id);
                const stored = (meta && meta.fields) || [];
                const next = stored.filter(f => f.id !== req.params.fieldId);
                const breaking = await breakingColumnUsage(req.datatable.id, stored, next);
                if (breaking.length && !confirmedBreaking(req)) {
                    return res.status(409).json({ error: 'Routines still use the column you are removing', code: 'breaking_change', breaking });
                }
                const formAnswers = require('../../automation/formAnswers');
                const out = await formAnswers.deleteRetiredColumn(req.datatable, req.datatableScope, req.params.fieldId);
                res.json({ fields: out.fields, modelVersion: out.modelVersion, source: publicSource(out.table.source, out.table.managedKind) });
            } catch (e) {
                if (answerDatatableError(res, e, req.datatableScope)) return;
                log.error('[datatables] answers column delete failed:', e.message);
                res.status(500).json({ error: 'Could not remove the column' });
            }
        });

    router.post('/:id/answers/release',
        requireDatatableGrade('owner'),
        requireManageForOrgScope(),
        requireAnswersTable,
        validate({ body: NOTHING, query: NO_QUERY }),
        async (req, res) => {
            try {
                if (req.datatable.source?.linked !== false) {
                    return res.status(409).json({
                        error: 'This table still collects the form\'s answers — switch that off on the form first',
                        code: 'still_linked',
                    });
                }
                const formAnswers = require('../../automation/formAnswers');
                const t = await formAnswers.releaseAnswersTable(req.datatable, req.datatableScope);
                res.json({ datatable: publicTable(t, req.datatableGrade) });
            } catch (e) {
                if (answerDatatableError(res, e, req.datatableScope)) return;
                log.error('[datatables] answers release failed:', e.message);
                res.status(500).json({ error: 'Could not release the table' });
            }
        });
}

module.exports = { register };
