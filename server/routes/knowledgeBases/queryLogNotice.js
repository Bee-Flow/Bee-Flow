// @typecheck strict
/**
 * Knowledge Bases — what a USER of a base sees of its query log, and the helper for the managers' form.
 *
 *   GET  /query-log/notice            which of these bases log (the notice under the chat input)
 *   POST /query-log/acknowledge       "understood": the recorded acknowledgement for these bases
 *   GET  /query-log/dpias             the DPIAs of the caller's organisation, for the enable form (managers only)
 *
 * The legal basis is legitimate interest, so the user is informed and the acknowledgement is recorded;
 * it is not consent. Until a user acknowledged a base, their questions to it are not logged
 * (core/kb/queryLog/recorder.mts). Only bases the caller can read are ever named.
 *
 * Mounted next to ./queryLog, before `detail`.
 */

const express = require('express');
const router = express.Router();
const kbStore = require('../../stores/knowledgeBases');
const { requireAuth, hasPermission, resolveUserOrgIds } = require('../../auth');
const { requireFeature: requireLicenseFeature } = require('../../license/middleware');
const license = require('../../license');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const { z, worded, bodyOf, queryOf } = require('../../core/http/schemaParts');
const { getUserId, canAccessKB } = require('./shared');
const { invalidateKbQueryLogAck } = require('../../core/kb/queryLog/recorder.mts');
const { showsNames } = require('../../core/kb/queryLog/askers.mts');
const { fallback } = require('../../utils/bestEffort');
const queryLogStore = require('../../stores/kb/queryLog/index.mts');
const orgViews = require('../../stores/kb/queryLog/orgViews.mts');
const dpiaStore = require('../../stores/dpiaStore');

/** @typedef {{ id: string, name: string, organization_id?: string | null, query_log_show_names?: boolean | null, query_log_retention_days?: number | null }} KbRow */

const FEATURE = 'kb_query_log';
const NOTICE_MAX_IDS = 50;

const AckBody = bodyOf({
    kbIds: z.array(worded('A knowledge base id is text.').trim().min(1).max(100), { error: 'kbIds is a list of knowledge base ids.' }).min(1, 'Name at least one knowledge base.').max(NOTICE_MAX_IDS, `At most ${NOTICE_MAX_IDS} knowledge bases at once.`),
}, 'The acknowledgement');

const NoticeQuery = queryOf({
    kbIds: worded('kbIds is a comma-separated list of knowledge base ids.').max(NOTICE_MAX_IDS * 40, 'kbIds is too long.'),
}, 'The notice');

// ── GET /query-log/notice, POST /query-log/acknowledge ─────────────

/**
 * The bases among `ids` that the caller can read, that log, and whose organisation holds the licence.
 * @param {import('express').Request} req @param {string[]} ids
 * @returns {Promise<KbRow[]>}
 */
async function loggingKbsOf(req, ids) {
    const userId = getUserId(req);
    /** @type {KbRow[]} */
    const readable = [];
    for (const id of ids) {
        const kb = await kbStore.getKB(id).catch((/** @type {unknown} */ e) => fallback('routes/knowledgeBases/queryLog:getKB', e, null));
        if (kb && (await canAccessKB(req, kb))) readable.push(kb);
    }
    const logging = new Set((await queryLogStore.getLoggingKbs(readable.map((k) => k.id))).map((k) => k.id));
    /** @type {KbRow[]} */
    const out = [];
    for (const kb of readable) {
        if (!logging.has(kb.id)) continue;
        // The same licence test the recorder applies: without it nothing is logged, so nothing is announced.
        if (!(await license.hasFeature({ organizationId: kb.organization_id ?? undefined, userId }, FEATURE))) continue;
        out.push(kb);
    }
    return out;
}

/** @param {import('express').Request} req @param {KbRow[]} kbs */
async function noticeOut(req, kbs) {
    const acked = new Set(await queryLogStore.validAckKbIds(getUserId(req), kbs.map((k) => k.id)));
    return {
        active: kbs.length > 0,
        kbs: kbs.map((kb) => ({
            id: kb.id, name: kb.name, acknowledged: acked.has(kb.id),
            retentionDays: Number(kb.query_log_retention_days) || 90, showNames: showsNames(kb),
        })),
    };
}

/** @param {string} raw */
const idsOf = (raw) => [...new Set(String(raw).split(',').map((s) => s.trim()).filter(Boolean))].slice(0, NOTICE_MAX_IDS);

router.get('/query-log/notice', requireAuth, validate({ query: NoticeQuery }), async (/** @type {import('express').Request<{}, any, any, any>} */ req, res) => {
    res.json(await noticeOut(req, await loggingKbsOf(req, idsOf(req.query.kbIds))));
});

// The user has read the notice. Bases the caller cannot read, that do not log, or of another organisation are ignored
// silently (same as in the notice), so this route cannot be used to probe for them.
router.post('/query-log/acknowledge', requireAuth, validate({ body: AckBody }), async (/** @type {import('express').Request<{}, any, import('zod').infer<typeof AckBody>>} */ req, res) => {
    const userId = getUserId(req);
    const kbs = await loggingKbsOf(req, [...new Set(req.body.kbIds)].slice(0, NOTICE_MAX_IDS));
    const ids = kbs.map((k) => k.id);
    if (userId && ids.length > 0) {
        await queryLogStore.acknowledge(userId, ids);
        invalidateKbQueryLogAck(userId, ids);
    }
    res.json(await noticeOut(req, kbs));
});

// ── GET /query-log/dpias ────────────────────────────────────────────
// The enable form picks a DPIA when the organisation says one is done. The compliance list needs
// `admin_compliance`, which a knowledge manager usually lacks, so this one is open to managers of the
// organisation's knowledge (the permission, or the owner of a base of the organisation) and lists the
// caller's own organisation only, with nothing but an id, a title and a status.

router.get('/query-log/dpias', requireAuth, requireLicenseFeature(FEATURE), validate({ query: queryOf({}, 'This request') }), async (/** @type {import('express').Request} */ req, res) => {
    const userId = getUserId(req);
    const orgIds = await resolveUserOrgIds(req);
    const orgId = [...(orgIds || [])][0] ?? null;
    const mayManage = !!orgId && ((await hasPermission(userId, 'manage_knowledge', req.session)) || (await orgViews.userOwnsKbInOrg(orgId, userId)));
    if (!orgId || !mayManage) throw new HttpError(404, 'not_found', 'Not found');
    const rows = await dpiaStore.listForOrgNamed(orgId);
    res.json({
        dpias: rows.map((/** @type {{ id: number | string, agent_id: string, title?: string | null, approved_at?: string | null, expires_at?: string | null }} */ r) => ({
            id: String(r.id), title: String(r.title || r.agent_id), status: dpiaStore.isCurrent(r) ? 'current' : 'expired',
        })),
    });
});

module.exports = router;
