/**
 * Deleting a table.
 *
 * The same question a column drop asks, one level up — the automations in the
 * usage index stop working the moment this table is gone, so it is asked once.
 * Metadata and rows go together or not at all, and a mirror is UNLINKED rather
 * than deleted at the source.
 */

'use strict';

const datatableStore = require('../../stores/datatableStore');
const datatableDbStore = require('../../stores/datatableDbStore');
const sources = require('../../core/dataEngine/sources');
const { requireDatatableGrade, requireManageForOrgScope } = require('./grade');
const { answerDatatableError, confirmedBreaking } = require('./refusals');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const { bodyOf, ConfirmBreakingQuery, CONFIRM_TEXT } = require('./schemas');
const log = require('../../telemetry/log');

// The confirmation is the only thing this route takes, and it is taken from
// BOTH places because a DELETE is routinely sent without a body. Strict on
// both: `?confirmbreaking=true` used to be dropped, which reads as "no" on the
// one request where "no" costs the person a second trip through the dialog.
const DeleteBody = bodyOf({ confirmBreaking: z.boolean({ invalid_type_error: CONFIRM_TEXT }).optional() });

function register(router) {
    router.delete('/:id',
        requireDatatableGrade('owner'),
        requireManageForOrgScope(),
        validate({ body: DeleteBody, query: ConfirmBreakingQuery }),
        async (req, res) => {
            try {
                // Same question as a column drop, one level up: the automations in the
                // usage index stop working the moment this table is gone. Ask once.
                if (!confirmedBreaking(req)) {
                    const usage = await datatableStore.listUsage(req.datatable.id);
                    if (usage.length) {
                        return res.status(409).json({
                            error: 'Automations still use this datatable',
                            code: 'in_use',
                            usage,
                        });
                    }
                }
                // Metadata and rows go together or not at all — see
                // datatableDbStore.dropDatatable. Anything thrown here is a 500, so
                // `{ok:true}` now means the physical table really is gone.
                const ok = await datatableDbStore.dropDatatable(req.datatable.id, req.datatableScope);
                if (!ok) return res.status(404).json({ error: 'Not found' });
                // A mirror is UNLINKED, never deleted at the source: the adapter
                // only forgets what it held about the link (a linker memo, a
                // subscription). Best-effort — the table is already gone here.
                const adapter = sources.sourceOf(req.datatable);
                if (adapter) {
                    try {
                        const link = adapter.link;
                        if (link && typeof link.unlinked === 'function') await link.unlinked(req.datatable);
                    } catch (e) {
                        log.warn('[datatables] unlink hook failed:', e && e.message);
                    }
                }
                res.json({ ok: true });
            } catch (e) {
                if (answerDatatableError(res, e, req.datatableScope)) return;
                log.error('[datatables] delete failed:', e.message);
                res.status(500).json({ error: 'Could not delete the datatable' });
            }
        });
}

module.exports = { register };
