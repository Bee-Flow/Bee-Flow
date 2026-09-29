/**
 * Who else may see this table, and who else already uses it.
 *
 * Publishing, granting and flipping write_mode are the paid boundary
 * (`automation_sharing`); REMOVING access deliberately is not gated at all, and
 * a personal table refuses the whole family outright. The usage answer sits
 * here because it is the same question from the other side: who else would
 * notice if this table changed.
 */

'use strict';

const { validateSharedGroupsForOrg } = require('../../auth');
const { requireCapability } = require('../../core/entitlements/entitlements');
const datatableStore = require('../../stores/datatableStore');
const {
    requireDatatableGrade, requireManageForOrgScope, refuseWhenPersonal,
} = require('./grade');
const { publicTable } = require('./projection');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const { bodyOf, choice, idText, worded } = require('./schemas');
const log = require('../../telemetry/log');

// The three audiences a person can pick. The route below is the ONLY place one
// becomes columns.
const AUDIENCES = ['private', 'organisation', 'groups'];
const WRITE_MODES = ['grants', 'audience'];

// ── What a caller may send ──────────────────────────────────────────
//
// `.strict()`, and on THIS route a dropped key was a lie about the answer.
// The body is read key by key — `audience`, then `writeMode`, then the two
// old-shape fields — and anything else fell off the end. So `{"audiance":
// "organisation"}` reached `setSharing` with nothing to set: the table's
// sharing was untouched and the answer was a 200 carrying the table, which is
// exactly what a successful save looks like. The person read "saved" and the
// table stayed private. Same for `{"writemode":"audience"}`.
const AUDIENCE_TEXT = 'Share this table privately, with the organisation, or with specific groups';
const WRITE_TEXT = 'Write access is either by invitation or open to the audience';
const SharingBody = bodyOf({
    // Typed, not enumerated: the WORD is judged in the handler so the refusal
    // keeps its own code (`bad_audience`). On a route where the difference
    // between two words is "private" and "the whole organisation", a caller
    // gets a machine-readable answer rather than a generic invalid_request.
    audience: worded(AUDIENCE_TEXT).trim().min(1, AUDIENCE_TEXT).optional(),
    writeMode: choice(WRITE_MODES, WRITE_TEXT).optional(),
    // The group ids themselves are validateSharedGroupsForOrg's to judge —
    // it is the one place that knows which groups this organisation has, and
    // it refuses an empty result by name (`groups_required`) rather than
    // letting it widen to the whole organisation.
    sharedGroups: z.array(z.unknown(), { invalid_type_error: 'sharedGroups is a list of group ids' }).optional(),
    // The OLD body shape, listed ONLY so the handler can answer the 409 that
    // tells an out-of-date tab to reload. Dropping it from the schema would
    // turn that 409 into a 400 and lose the instruction with it.
    isPublished: z.boolean({ invalid_type_error: 'isPublished is true or false' }).optional(),
});

const GRANTEE_TEXT = 'Share with a person or a group';
const GRANTEE_ID_TEXT = 'Say who to share with';
const GRADE_TEXT = 'Choose read or read-and-write';
const GrantBody = bodyOf({
    granteeType: choice(['user', 'group'], GRANTEE_TEXT),
    // `grantee_id` is NOT NULL, so a grant with no grantee used to come back
    // as a bare 500 "Could not share the datatable" from a constraint nobody
    // outside this file can read.
    granteeId: idText(GRANTEE_ID_TEXT),
    grade: choice(['viewer', 'editor'], GRADE_TEXT),
});

const NO_QUERY = z.object({}).strict();

function register(router) {
    /**
     * PUT /:id/sharing — who may read this table, and separately who may write it.
     *
     * INVARIANT: an empty `shared_groups` on a PUBLISHED table means the WHOLE
     * ORGANISATION, and it means it for READING ONLY. auth/audience.canSeePublished
     * answers the read question; auth/datatableAccess.gradeForPrincipal only ever
     * returns 'editor' off an explicit grant or write_mode:'audience'. Both halves
     * have to survive every future edit to this descriptor — one field governing
     * both would turn "share this with the company" into "let the company delete
     * the rows".
     *
     * The body is an `audience` word rather than the old `{isPublished,
     * sharedGroups}` pair because those two could contradict each other and the
     * server could not tell which the caller meant. `{isPublished:true,
     * sharedGroups:[]}` is what the Studio's "Specific groups" option sent on a
     * table that had no groups yet: the NARROWEST choice on screen published the
     * rows to everyone. A word cannot say that.
     */
    router.put('/:id/sharing',
        requireDatatableGrade('owner'),
        refuseWhenPersonal,
        requireManageForOrgScope(),
        requireCapability('automation_sharing'),
        validate({ body: SharingBody, query: NO_QUERY }),
        async (req, res) => {
            try {
                const body = req.body;
                const { audience, writeMode } = body;
                const patch = { writeMode };

                if (audience !== undefined) {
                    if (!AUDIENCES.includes(audience)) {
                        return res.status(400).json({
                            error: AUDIENCE_TEXT,
                            code: 'bad_audience',
                        });
                    }
                    if (audience === 'groups') {
                        // requireNonEmpty, because [] here would publish org-wide.
                        // A 400 is the only honest answer to "share with groups"
                        // when no group survived validation.
                        patch.sharedGroups = await validateSharedGroupsForOrg(
                            req.datatable.organizationId, body.sharedGroups, { requireNonEmpty: true });
                        patch.isPublished = true;
                    } else {
                        // 'private' and 'organisation' both clear the group list;
                        // they differ only in whether the table is published.
                        patch.isPublished = audience === 'organisation';
                        patch.sharedGroups = [];
                    }
                } else if (body.isPublished !== undefined || body.sharedGroups !== undefined) {
                    // The OLD body shape, refused rather than honoured.
                    //
                    // It is tempting to keep accepting it for a release. Don't: the
                    // ambiguity it carries IS the bug this route was rewritten to
                    // remove. `{isPublished:true, sharedGroups:[]}` cannot be told
                    // apart from a deliberate org-wide publish, and auth/audience.js
                    // reads an empty list on a published table as THE WHOLE
                    // ORGANISATION.
                    //
                    // And there is no caller to protect. /api/datatables shipped in
                    // the same release as the SPA that calls it, and the decisions
                    // record rules out a public REST API for datatables — so the only
                    // realistic sender is a browser tab still running the OLD bundle.
                    // That tab emits exactly this shape when someone picks "specific
                    // groups", which is the disclosure itself. Compatibility here
                    // would preserve the hazard for the one caller that has it.
                    //
                    // 409, not 400: nothing about the request is malformed, the
                    // client is simply out of date, and 'reload' is the fix.
                    return res.status(409).json({
                        error: 'This page is out of date — reload it and choose the audience again',
                        code: 'stale_client',
                    });
                }

                const t = await datatableStore.setSharing(req.datatable.id, req.datatableScope, patch);
                res.json({ datatable: publicTable(t, 'owner') });
            } catch (e) {
                // e.code carries the machine-readable half (groups_required) so the
                // surface can say "pick a group" instead of a generic failure.
                if (e.status) return res.status(e.status).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });
                log.error('[datatables] sharing failed:', e.message);
                res.status(500).json({ error: 'Could not update sharing' });
            }
        });

    router.post('/:id/grants',
        requireDatatableGrade('owner'),
        refuseWhenPersonal,
        requireManageForOrgScope(),
        requireCapability('automation_sharing'),
        validate({ body: GrantBody, query: NO_QUERY }),
        async (req, res) => {
            try {
                const { granteeType, granteeId, grade } = req.body;
                if (granteeType === 'group') await validateSharedGroupsForOrg(req.datatable.organizationId, [granteeId]);
                const grants = await datatableStore.addGrant(req.datatable.id, req.datatableScope,
                    { granteeType, granteeId, grade, grantedBy: req.session.user.id });
                res.json({ grants });
            } catch (e) {
                if (e.status) return res.status(e.status).json({ error: e.message });
                log.error('[datatables] grant failed:', e.message);
                res.status(500).json({ error: 'Could not share the datatable' });
            }
        });

    router.delete('/:id/grants/:grantId',
        requireDatatableGrade('owner'),
        requireManageForOrgScope(),
        async (req, res) => {
            // Deliberately NOT licence-gated, and deliberately NOT refused on a
            // personal table either: removing access must always be possible, and a
            // table that holds no grants answers this with an empty list anyway.
            try {
                res.json({ grants: await datatableStore.removeGrant(req.datatable.id, req.params.grantId) });
            } catch (e) {
                log.error('[datatables] grant removal failed:', e.message);
                res.status(500).json({ error: 'Could not remove the share' });
            }
        });

    router.get('/:id/grants', requireDatatableGrade('viewer'), async (req, res) => {
        res.json({ grants: await datatableStore.listGrants(req.datatable.id) });
    });

    // ── Who else uses this table ────────────────────────────────────────────────

    router.get('/:id/usage', requireDatatableGrade('viewer'), async (req, res) => {
        try {
            res.json({ usage: await datatableStore.listUsage(req.datatable.id) });
        } catch (e) {
            log.error('[datatables] usage read failed:', e.message);
            res.status(500).json({ error: 'Could not load who uses this datatable' });
        }
    });
}

module.exports = { register };
