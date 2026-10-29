// @typecheck
/**
 * Website forms, admin side (mounted behind requireAdmin by routes/cms.js):
 * which automations a CMS `form` block may start, and which blocks may target
 * each. The public endpoint that enforces it is routes/cmsForms.js.
 *
 *   GET  /api/cms/admin/form-automations
 *   PUT  /api/cms/admin/form-automations/:automationId                 { enabled }
 *   PUT  /api/cms/admin/form-automations/:automationId/blocks/:blockId { approved }
 *
 * CMS admin alone is not enough. The run executes AS the automation's owner,
 * on anonymous input, so enabling asks what the automation routes ask of an
 * editor (owner, an edit share, or manage_automations in its organisation),
 * with the organisation read fresh. Every enable, disable and approval is
 * audited.
 */

'use strict';

const express = require('express');
const { HttpError, notFound } = require('../core/http/errors');
const { validate } = require('../core/http/validate');
const { z, bodyOf } = require('../core/http/schemaParts');
const websiteForms = require('../core/cms/websiteForms');

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const EnableBody = bodyOf({ enabled: z.boolean({ error: 'enabled is true or false.' }) }, 'Enabling an automation for website forms');
const ApproveBody = bodyOf({ approved: z.boolean({ error: 'approved is true or false.' }) }, 'Approving a form block');

/**
 * @typedef {{ userOrg: (userId: string) => Promise<string | null>, // the caller's organisation, read fresh (the session may be stale)
 *   listActiveAutomationsOfOrg: (organizationId: string | null) => Promise<(Record<string, any> & { id: string })[]>,
 *   getAutomation: (id: string) => Promise<(Record<string, any> & { id: string }) | null>,
 *   organisationOf: (automation: Record<string, any>) => Promise<string | null>,
 *   canEdit: (automation: Record<string, any> & { id: string }, userId: string, session: unknown) => Promise<boolean>, // owner, edit share, or manage_automations
 *   listFormAutomations: () => Promise<Map<string, { organizationId: string | null, blockIds: string[] }>>,
 *   enableFormAutomation: (id: string, meta: { organizationId: string | null, enabledBy: string | null }) => Promise<void>,
 *   disableFormAutomation: (id: string) => Promise<void>,
 *   setBlockApproved: (id: string, blockId: string, approved: boolean) => Promise<void>,
 *   listDraftFormBlocks: () => Promise<{ blockId: string, pageId: string, pageTitle: string, automationId: string }[]>,
 *   getDrops: (blockIds: string[]) => Promise<Record<string, { honeypot: number, tooFast: number }>>,
 *   audit: (action: string, targetType: string, targetId: string, actorId: string | null, before: Record<string, unknown> | null, after: Record<string, unknown> | null, orgId: string | null) => Promise<unknown> }} AdminDeps
 */

/**
 * The admin router; mounted behind requireAdmin. An admin sees and changes
 * only automations they could edit themselves, in their own organisation.
 * @param {AdminDeps} deps
 */
function createAdminRouter(deps) {
    const router = express.Router();
    const actorOf = (/** @type {import('express').Request} */ req) => req.session?.user?.id || null;

    /**
     * The automation if this caller may enable it for website forms, else a 404
     * (a 403 would confirm it exists). The form run executes AS the owner, on
     * anonymous input, so this asks what the automation routes ask of an
     * editor, and refuses a kind that is not an automation or one outside the
     * caller's own, freshly read, organisation.
     * @param {import('express').Request} req
     */
    async function editableAutomation(req) {
        const userId = actorOf(req);
        const automation = userId ? await deps.getAutomation(/** @type {string} */ (req.params.automationId)) : null;
        if (!userId || !automation || automation.kind !== 'automation') throw notFound('automation_not_found', 'Automation not found.');
        const [mine, theirs] = await Promise.all([deps.userOrg(userId), deps.organisationOf(automation)]);
        if (!mine || mine !== theirs || !(await deps.canEdit(automation, userId, req.session))) {
            throw notFound('automation_not_found', 'Automation not found.');
        }
        return { automation, userId, orgId: mine };
    }

    router.get('/form-automations', async (req, res) => {
        const userId = actorOf(req);
        const org = userId ? await deps.userOrg(userId) : null;
        if (!userId || !org) return res.json({ automations: [] });
        const [automations, enabled, blocks] = await Promise.all([
            deps.listActiveAutomationsOfOrg(org), deps.listFormAutomations(), deps.listDraftFormBlocks(),
        ]);
        const drops = await deps.getDrops(blocks.map((b) => b.blockId));
        const out = [];
        for (const a of automations) {
            if (a.kind !== 'automation' || !websiteForms.webhookTriggerId(a) || !(await deps.canEdit(a, userId, req.session))) continue;
            const entry = enabled.get(a.id);
            out.push({
                id: a.id,
                title: a.title || '',
                enabled: !!entry,
                blocks: blocks.filter((b) => b.automationId === a.id).map((b) => ({
                    blockId: b.blockId,
                    pageTitle: b.pageTitle,
                    approved: !!entry && entry.blockIds.includes(b.blockId),
                    drops: drops[b.blockId] || { honeypot: 0, tooFast: 0 },
                })),
            });
        }
        return res.json({ automations: out });
    });

    router.put('/form-automations/:automationId', validate({ body: EnableBody }), async (/** @type {import('express').Request<{ automationId: string }, any, import('zod').infer<typeof EnableBody>, import('qs').ParsedQs>} */ req, res) => {
        const { automation, userId, orgId } = await editableAutomation(req);
        const wasEnabled = (await deps.listFormAutomations()).has(automation.id);
        if (req.body.enabled) {
            if (!websiteForms.webhookTriggerId(automation)) {
                throw new HttpError(400, 'no_webhook_trigger', 'Only an automation with a webhook trigger can receive website forms.');
            }
            await deps.enableFormAutomation(automation.id, { organizationId: orgId, enabledBy: userId });
        } else {
            await deps.disableFormAutomation(automation.id);
        }
        await deps.audit(req.body.enabled ? 'cms.form_automation.enable' : 'cms.form_automation.disable', 'automation', automation.id, userId,
            { enabled: wasEnabled }, { enabled: req.body.enabled }, orgId);
        res.json({ id: automation.id, enabled: req.body.enabled });
    });

    router.put('/form-automations/:automationId/blocks/:blockId', validate({ body: ApproveBody }), async (/** @type {import('express').Request<{ automationId: string, blockId: string }, any, import('zod').infer<typeof ApproveBody>, import('qs').ParsedQs>} */ req, res) => {
        const { automation, userId, orgId } = await editableAutomation(req);
        const { blockId } = /** @type {{ blockId: string }} */ (req.params);
        if (!ID_RE.test(blockId)) throw notFound('block_not_found', 'Form block not found.');
        if (!(await deps.listFormAutomations()).has(automation.id)) {
            throw new HttpError(409, 'not_enabled', 'Enable this automation for website forms first.');
        }
        if (req.body.approved) {
            // Only a block that really targets this automation can be approved.
            const targets = (await deps.listDraftFormBlocks()).some((b) => b.blockId === blockId && b.automationId === automation.id);
            if (!targets) throw notFound('block_not_found', 'Form block not found.');
        }
        await deps.setBlockApproved(automation.id, blockId, req.body.approved);
        await deps.audit('cms.form_block.approve', 'automation', automation.id, userId, null, { blockId, approved: req.body.approved }, orgId);
        res.json({ id: automation.id, blockId, approved: req.body.approved });
    });

    return router;
}

/** The admin router wired to the real stores. */
function createDefaultAdminRouter() {
    const cmsStore = require('../stores/cmsStore');
    const automationStore = require('../stores/automationStore');
    const userStore = require('../stores/userStore');
    const formAutomations = require('../stores/cms/formAutomations');
    const access = require('../automation/access').makeAutomationAccess();
    const { getLiveSiteId } = require('./cmsShared');
    return createAdminRouter({
        userOrg: async (userId) => (await userStore.getUser(userId))?.organizationId || null,
        listActiveAutomationsOfOrg: (orgId) => automationStore.listActiveAutomationsOfOrg(orgId),
        getAutomation: (id) => automationStore.getAutomation(id),
        organisationOf: access.organisationOf,
        canEdit: (automation, userId, session) => access.canAccessAutomation(automation, userId, 'edit', { session }),
        listFormAutomations: formAutomations.listFormAutomations,
        enableFormAutomation: formAutomations.enableFormAutomation,
        disableFormAutomation: formAutomations.disableFormAutomation,
        setBlockApproved: formAutomations.setBlockApproved,
        // The live site's DRAFT: where a block is edited, before it is published.
        listDraftFormBlocks: async () => {
            const siteId = await getLiveSiteId();
            const site = siteId ? await cmsStore.getProject(siteId) : null;
            if (!siteId || !site) return [];
            const pages = await Promise.all((Array.isArray(site.pages) ? site.pages : []).map((p) => cmsStore.getPage(siteId, p.id)));
            return websiteForms.formBlocksOf(pages.filter((p) => p));
        },
        getDrops: require('../stores/cms/formDrops').getFormDrops,
        audit: (...a) => userStore.logAccessAudit(...a),
    });
}

module.exports = { createAdminRouter, createDefaultAdminRouter };
