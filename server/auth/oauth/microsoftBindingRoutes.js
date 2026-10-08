'use strict';
const router = require('express').Router();
const { requireSuperAdmin, invalidatePermissionCache } = require('../permissions');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const store = require('../../stores/microsoftIdentityStore');
const configStore = require('../../stores/configStore');
const { GUID } = require('../microsoftIdentity');
const { start, stopAllPeriodicSyncs } = require('../../integrations/azureGroupSync');

router.get('/microsoft/link-requests', requireSuperAdmin, async (_req, res) => res.json(await store.listRequests()));
router.put('/microsoft/users/:userId/identity', requireSuperAdmin,
    validate({ body: z.object({ requestId: z.string().uuid() }).strict() }), async (req, res) => {
        await store.bind(req.params.userId, req.body.requestId, req.session.user.id);
        await invalidatePermissionCache(req.params.userId);
        res.json({ ok: true });
    });
router.delete('/microsoft/users/:userId/identity', requireSuperAdmin, async (req, res) => {
    await store.unbind(req.params.userId, req.session.user.id);
    await invalidatePermissionCache(req.params.userId);
    res.json({ ok: true });
});
router.get('/microsoft/sync-binding', requireSuperAdmin, async (_req, res) => res.json(await configStore.getConfigFresh('azure_group_sync_binding') || {}));
router.put('/microsoft/sync-binding', requireSuperAdmin,
    validate({ body: z.object({ syncOrganizationId: z.string().trim().min(1).max(128),
        syncTenantId: z.string().regex(GUID).transform(v => v.toLowerCase()) }).strict() }), async (req, res) => {
        const userStore = require('../../stores/userStore');
        const actor = await userStore.getUser(req.session.user.id);
        if (actor?.role !== 'admin' || actor.status === 'suspended') return res.status(403).json({ error: 'Only an active platform administrator may bind directory sync.' });
        const org = await userStore.getOrganization(req.body.syncOrganizationId);
        if (!org) return res.status(400).json({ error: 'Select an existing organization.' });
        const { loadConfig } = require('../permissions');
        const { tenantId } = (await loadConfig()).providers.microsoft || {};
        if (GUID.test(tenantId || '') && tenantId.toLowerCase() !== req.body.syncTenantId) {
            return res.status(400).json({ error: 'The sync tenant must match the Microsoft SSO tenant.' });
        }
        await require('../../integrations/azureSyncLock').withAzureSyncLock(() =>
            configStore.setConfig('azure_group_sync_binding', { ...req.body, configuredBy: req.session.user.id, configuredAt: new Date().toISOString() }));
        stopAllPeriodicSyncs();
        start(0);
        res.json({ ok: true });
    });
module.exports = router;
