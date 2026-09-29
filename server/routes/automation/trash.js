/**
 * The automation trash (Studio → Automations handoff 5).
 *
 *   DELETE /:id          move a routine into the trash (soft delete)
 *   GET    /_trash       the caller's trashed routines, with their purge date
 *   POST   /:id/restore  take one out again, PAUSED
 *
 * A delete used to be final and took every run with it (the FKs cascade). Now
 * the routine is switched off, its remote event subscriptions are revoked
 * (a provider-side subscription would otherwise keep firing at nobody) and it
 * waits in the trash for TRASH_RETENTION_DAYS with its runs, answers tables
 * and "used by" entries intact, so a restore brings back exactly what was
 * there. jobs/automationTrashPurge.js does the final delete and the cleanup
 * the old DELETE did inline.
 *
 * Registered by crud.js (GET /_trash above GET /:id, so the literal wins).
 * Handlers come from a factory so a test can hand them a store of its own.
 */

'use strict';

const { TRASH_RETENTION_DAYS } = require('../../stores/automationStore/lifecycle');
const { projectForViewer } = require('../../automation/access');

function purgeAtOf(deletedAt) {
    if (!deletedAt) return null;
    return new Date(new Date(deletedAt).getTime() + TRASH_RETENTION_DAYS * 86_400_000).toISOString();
}

/**
 * @param {{
 *   store: { getAutomation: Function, trashAutomation: Function, restoreAutomation: Function,
 *            listTrash: Function, deleteSubscriptionsForAutomation: Function },
 *   revokeRemoteSubscriptions: (automationId: string, userId: string) => Promise<void>,
 *   wakeComplianceReview?: (a: object, reason: string) => void,
 *   access?: { guard: (req, res, a, need) => Promise<object|null> },
 * }} deps
 *
 * `access` is automation/access.js's guard (handoff 5 sharing): moving a
 * routine to the trash and taking it out again need the OWNER (or an org
 * admin with manage_automations). Without it, the owner alone.
 */
function makeTrashHandlers(deps) {
    const { store, revokeRemoteSubscriptions } = deps;
    const wake = typeof deps.wakeComplianceReview === 'function' ? deps.wakeComplianceReview : () => {};
    // The caller's access (owner or org admin), or null after answering 403.
    const ownerOnly = async (req, res, a) => {
        if (deps.access) return deps.access.guard(req, res, a, 'owner');
        if (a.userId === req.session.user.id) return { role: 'owner', via: 'owner' };
        res.status(403).json({ error: 'Forbidden' });
        return null;
    };

    async function trash(req, res) {
        const userId = req.session.user.id;
        const a = await store.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        const access = await ownerOnly(req, res, a);
        if (!access) return;
        // Remote (MS Graph, Gmail watch) subscriptions first, then the local
        // rows — the same order as deactivate, for the same reason. With the
        // owner's connection: the subscription was made on their account.
        await revokeRemoteSubscriptions(a.id, a.userId || userId);
        await store.deleteSubscriptionsForAutomation(a.id);
        const trashed = await store.trashAutomation(a.id, userId);
        if (!trashed) return res.status(404).json({ error: 'Not found' });
        // A routine that was running is not any more: same posture change as
        // a deactivation.
        if (a.isActive) wake(a, 'deactivation');
        // Projected like every other answer: an org admin does not get the
        // owner's builder chat.
        res.json({ success: true, automation: projectForViewer(trashed, access), purgeAt: purgeAtOf(trashed.deletedAt) });
    }

    async function listTrash(req, res) {
        const rows = await store.listTrash(req.session.user.id);
        res.json({ automations: rows, retentionDays: TRASH_RETENTION_DAYS });
    }

    async function restore(req, res) {
        const a = await store.getAutomation(req.params.id, { includeDeleted: true });
        if (!a || !a.deletedAt) return res.status(404).json({ error: 'Not found', code: 'not_in_trash' });
        const access = await ownerOnly(req, res, a);
        if (!access) return;
        const restored = await store.restoreAutomation(a.id);
        if (!restored) return res.status(404).json({ error: 'Not found', code: 'not_in_trash' });
        res.json({ automation: projectForViewer(restored, access) });
    }

    return { trash, listTrash, restore };
}

module.exports = { makeTrashHandlers, purgeAtOf };
