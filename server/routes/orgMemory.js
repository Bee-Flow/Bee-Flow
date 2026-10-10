/**
 * Organization Memory API
 *
 * The org layer of the memory policy (core/memory/memoryPolicy.js, configStore
 * key `org_memory_<orgId>`): whether memory is on for the organisation at all,
 * whether members may opt in to sensitive memories, and the per-user cap.
 *
 *   GET  /:orgId        settings + counts (never memory content)
 *   PUT  /:orgId        save settings (org admin or super admin) -> {settings, stats, deletedSensitive?};
 *                       turning sensitiveOptInAllowed off hard-deletes the org's art. 9 memories
 *                       and clears every member's opt-in flag, so a later re-enable needs fresh consent
 *   POST /:orgId/clear  delete every memory of every user in the org
 *
 * All three are admin-only: the counts say how many people use memory, and
 * that is not for every member. Members learn about the switch through
 * `orgMemoryEnabled` on their own user settings instead.
 */

const express = require('express');
const log = require('../telemetry/log');
const { HttpError } = require('../core/http/errors');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

// `.strict()`: a misspelled field must be refused, not dropped under a 200.
// maxPerUser is clamped by the policy module (50..10000), but it has to be a
// number to begin with.
const bodyOf = (shape) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape, { invalid_type_error: 'Send the settings as a JSON object.' }).strict(),
);

const SettingsBody = bodyOf({
    enabled: z.boolean({ invalid_type_error: 'enabled is true or false.' }).optional(),
    sensitiveOptInAllowed: z.boolean({ invalid_type_error: 'sensitiveOptInAllowed is true or false.' }).optional(),
    maxPerUser: z.number({ invalid_type_error: 'maxPerUser is a number.' }).finite('maxPerUser is a number.').optional(),
});

const ClearBody = z.object({
    confirm: z.literal('DELETE', { errorMap: () => ({ message: 'Send {"confirm":"DELETE"} to clear the memories of this organisation.' }) }),
}, { invalid_type_error: 'Send {"confirm":"DELETE"} to clear the memories of this organisation.' }).strict();

/** The real collaborators; `createOrgMemoryRouter(deps)` takes fakes in tests. */
function makeDefaultDeps() {
    const { requireAuth, isOrgAdminForOrg } = require('../auth/permissions');
    const { getOrgMemorySettings, setOrgMemorySettings } = require('../core/memory/memoryPolicy');
    return {
        requireAuth,
        isOrgAdmin: isOrgAdminForOrg,
        getOrgMemorySettings,
        setOrgMemorySettings,
        memoryStore: require('../stores/memoryStore'),
        memoryQueries: require('../stores/memoryQueries'),
        userStore: require('../stores/userStore'),
        configStore: require('../stores/configStore'),
        sensitiveOptInKey: require('../core/memory/memoryPolicy').memorySensitiveOptInKey,
    };
}

function createOrgMemoryRouter(deps = null) {
    const d = deps || makeDefaultDeps();
    const { requireAuth, getOrgMemorySettings, setOrgMemorySettings, memoryStore, memoryQueries, userStore } = d;
    const BATCH = 25;
    const router = express.Router();

    async function requireAdminOf(req) {
        if (!(await d.isOrgAdmin(req, req.params.orgId))) {
            throw new HttpError(403, 'forbidden', 'Only organization admins can manage memory settings');
        }
    }

    /** Never throws: an audit gap must not block the admin action. */
    async function audit(action, req, before, after) {
        try {
            await userStore.logAccessAudit(
                action, 'organization', req.params.orgId, req.session?.user?.id || 'system', before, after, req.params.orgId,
            );
        } catch (_) { /* logAccessAudit already swallows; belt and braces */ }
    }

    /**
     * Withdraw every member's sensitive opt-in. The consent was given under an
     * org permission that is gone; when the org allows it again, each person
     * has to say yes again. One bounded pass in batches (configStore has no
     * multi-key delete, and its cache must see each change). A failure is
     * logged, not thrown: the deletion above already made the flags inert.
     */
    async function clearSensitiveOptIns(orgId) {
        try {
            const ids = await memoryQueries.listOrgUserIds(orgId);
            for (let i = 0; i < ids.length; i += BATCH) {
                await Promise.all(ids.slice(i, i + BATCH).map((id) => d.configStore.deleteConfig(d.sensitiveOptInKey(id))));
            }
            return ids.length;
        } catch (err) {
            log.warn(`[OrgMemory] org ${orgId}: clearing the sensitive opt-ins failed: ${err.message}`);
            return 0;
        }
    }

    router.get('/:orgId', requireAuth, async (req, res) => {
        await requireAdminOf(req);
        const [settings, stats] = await Promise.all([
            getOrgMemorySettings(req.params.orgId),
            memoryStore.countOrgMemoryStats(req.params.orgId),
        ]);
        res.json({ settings, stats });
    });

    router.put('/:orgId', requireAuth, validate({ body: SettingsBody }), async (req, res) => {
        await requireAdminOf(req);
        const { orgId } = req.params;
        const before = await getOrgMemorySettings(orgId);
        const settings = await setOrgMemorySettings(orgId, req.body);
        // The org stops allowing sensitive (art. 9) memories: the permission the
        // members' opt-ins rested on is gone, so what was stored under it goes
        // too. After the save, so nothing new can be written meanwhile.
        const withdrawn = before.sensitiveOptInAllowed && !settings.sensitiveOptInAllowed;
        const deletedSensitive = withdrawn ? await memoryQueries.deleteSensitiveForOrg(orgId) : 0;
        if (withdrawn) await clearSensitiveOptIns(orgId);
        await audit('org.memory.update', req, before, deletedSensitive > 0 ? { ...settings, deletedSensitive } : settings);
        log.info(`[OrgMemory] org ${orgId}: memory ${settings.enabled ? 'enabled' : 'DISABLED'}${deletedSensitive ? `, ${deletedSensitive} sensitive memories deleted` : ''}`);
        const stats = await memoryStore.countOrgMemoryStats(orgId);
        res.json({ settings, stats, deletedSensitive });
    });

    router.post('/:orgId/clear', requireAuth, validate({ body: ClearBody }), async (req, res) => {
        await requireAdminOf(req);
        const { orgId } = req.params;
        const deleted = await memoryStore.deleteMemoriesForOrg(orgId);
        await audit('org.memory.clear', req, null, { deleted });
        log.info(`[OrgMemory] org ${orgId}: cleared ${deleted} memories`);
        res.json({ deleted });
    });

    return router;
}

const router = createOrgMemoryRouter();

module.exports = router;
module.exports.createOrgMemoryRouter = createOrgMemoryRouter;
