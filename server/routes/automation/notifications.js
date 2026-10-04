/**
 * An automation's notifications, as the Settings page shows them
 * (Studio → Automations handoff 5):
 *
 *   GET /:id/notifications   the policy (normalised: an old-shape automation
 *                            comes back in the new shape), the defaults, which
 *                            channels can actually deliver here, and the
 *                            latest delivery attempts.
 *
 * The policy is saved with the rest of the definition (PUT /:id with
 * definition.notificationSettings); this route only reads. Who hears about a
 * run follows the WORKING copy (core/automationRunner/runNotifications.js),
 * so a saved change applies without publishing.
 *
 * Built by a factory so a test hands in its own store and lookups.
 */

'use strict';

const express = require('express');
const log = require('../../telemetry/log');
const { makeAutomationAccess } = require('../../automation/access');
const {
    NOTIFICATION_DEFAULTS, normalizeNotificationSettings,
} = require('../../automation/notificationDefaults');

/**
 * @param {object} [overrides]
 * @param {object}   [overrides.store]         automationStore surface (getAutomation)
 * @param {object}   [overrides.events]        notificationEvents store (listRecentNotificationEvents)
 * @param {Function} [overrides.getUser]       (id) => user row
 * @param {Function} [overrides.hasPermission] (userId, perm, session) => bool
 * @param {Function} [overrides.emailConfigured] async () => bool
 * @param {Function} [overrides.talkStatus]    async ({ orgId, settings }) => { room, bot }
 */
function makeNotificationsRouter(overrides = {}) {
    const router = express.Router();
    const store = () => overrides.store || require('../../stores/automationStore');
    const events = () => overrides.events || require('../../stores/automationStore/notificationEvents');
    const getUser = overrides.getUser || ((id) => require('../../stores/userStore').getUser(id));
    const access = makeAutomationAccess({
        store: overrides.store,
        getUser,
        ...(overrides.hasPermission ? { hasPermission: overrides.hasPermission } : {}),
    });
    const emailConfigured = overrides.emailConfigured || (async () => {
        const cfg = await require('../../utils/emailService').getServiceEmailConfig().catch(() => null);
        return !!cfg?.configured;
    });
    const talkStatus = overrides.talkStatus || (async ({ orgId, settings }) => {
        const delivery = require('../../automation/approvalDelivery');
        const room = settings.onApproval.talkRoom || settings.onError.talkRoom || settings.onSuccess.talkRoom
            || await delivery.resolveTalkRoom({ orgId }).catch(() => null);
        const bot = orgId ? !!(await require('../../integrations/nextcloudTalkBot').getBotSecret(orgId).catch(() => null)) : false;
        return { room: room || null, bot };
    });

    router.get('/:id/notifications', async (req, res) => {
        const a = await store().getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        const acc = await access.guard(req, res, a, 'view');
        if (!acc) return undefined;

        const settings = normalizeNotificationSettings(a.definition?.notificationSettings);
        const owner = await Promise.resolve(getUser(a.userId)).catch(() => null);
        const orgId = a.organizationId || owner?.organizationId || null;

        const [mail, talk, recent] = await Promise.all([
            Promise.resolve(emailConfigured()).catch(() => false),
            Promise.resolve(talkStatus({ orgId, settings })).catch(() => ({ room: null, bot: false })),
            Promise.resolve(events().listRecentNotificationEvents(a.id, { limit: 20 })).catch((e) => {
                log.warn(`[automation notifications] recent events for ${a.id}: ${e.message}`);
                return [];
            }),
        ]);

        return res.json({
            settings,
            defaults: NOTIFICATION_DEFAULTS,
            channels: {
                bell: { available: true, nextcloud: !!(owner?.nc_uid || owner?.ncUid) },
                email: { available: !!mail, ...(mail ? {} : { reason: 'no_service_email' }) },
                talk: {
                    available: !!talk.room,
                    room: talk.room,
                    bot: !!talk.bot,
                    ...(talk.room ? {} : { reason: 'no_talk_room' }),
                },
            },
            recent: recent.map(e => ({
                event: e.event,
                channel: e.channel,
                // A Talk row's recipient is its conversation; a person's id
                // is only shown to people who may read the automation anyway.
                recipient: e.recipient,
                urgency: e.urgency,
                createdAt: e.createdAt,
                delivered: !!e.deliveredAt,
                bundled: e.bundled,
                runId: e.runId,
            })),
        });
    });

    return router;
}

module.exports = { makeNotificationsRouter };
