// @typecheck
'use strict';

/**
 * Admin notices — the ONE way the Compliance Center puts something in the
 * bell of the people who answer for compliance.
 *
 * WHO. Everyone who holds the compliance duty in the organisation: an org
 * admin (and the legacy 'admin' spelling), and the DPO. The event handlers
 * used to ask for admins only, so a DPO — the person a DSR or a breach signal
 * is actually for — never heard of either, while the deadline notifier did
 * include them; one query now serves both. A suspended account is not asked.
 * The org id 'default' is the bucket single-tenant installs live in (users
 * whose organisation is empty), matched the way routes/compliance/shared.js
 * resolves it.
 *
 * HOW OFTEN. A notice can carry a `dedupe` key: the first call in its window
 * (an hour or a day) claims it in compliance_notify_log, every later call in
 * the same window sends nothing — across replicas, because the claim is a
 * primary-key insert. A burst of the same signal is one line in the bell, not
 * one per emit. When the claim itself cannot be written the notice goes out
 * anyway: a duplicate is a nuisance, a DSR notice that vanished is not.
 *
 * WHAT. Titles and messages are built by the callers from ids, counts and
 * fixed text only. Nothing here reads or writes personal data beyond the
 * recipients' user ids, and nothing is ever sent outside Bee Flow.
 */

const log = require('../telemetry/log');

const RECIPIENT_SQL = `
    SELECT id FROM users
    WHERE COALESCE(NULLIF("organizationId", ''), 'default') = $1
      AND (role = 'admin' OR "orgRole" IN ('org_admin', 'admin', 'dpo'))
      AND (status IS NULL OR status = '' OR status = 'active')
`;

function _windowKey(window, nowMs) {
    const iso = new Date(nowMs).toISOString();
    return window === 'hour' ? iso.slice(0, 13) : iso.slice(0, 10);
}

/**
 * @param {{ getAll?: Function, notificationStore?: any, complianceStore?: any, now?: () => number }} [deps]
 */
function makeAdminNotices(deps = {}) {
    const d = {
        getAll: deps.getAll || ((/** @type {string} */ sql, /** @type {any[]} */ params) => require('../db').getAll(sql, params)),
        notificationStore: () => deps.notificationStore || (() => {
            try { return require('../stores/notificationStore'); } catch { return null; }
        })(),
        complianceStore: () => deps.complianceStore || require('../stores/complianceStore'),
        now: deps.now || (() => Date.now()),
    };

    /** User ids of the org's admins and DPOs (active accounts only). */
    async function recipients(orgId) {
        if (!orgId) return [];
        const rows = await d.getAll(RECIPIENT_SQL, [String(orgId)]);
        return (rows || []).map(r => r.id).filter(Boolean);
    }

    /** True when this call won the window for `dedupe.key` (or there is no key). */
    async function _claim(orgId, dedupe) {
        if (!dedupe || !dedupe.key) return true;
        try {
            return await d.complianceStore().markNotified(
                orgId, 'admin_notice', String(dedupe.key), _windowKey(dedupe.window, d.now()),
            );
        } catch (e) {
            log.warn('[ComplianceNotices] dedupe claim failed, sending anyway:', e?.message || e);
            return true;
        }
    }

    /**
     * Notify every admin and DPO of the org. Never throws.
     * @param {string} orgId
     * @param {{ category: string, title: string, message: string, link?: string|null,
     *           dedupe?: { key: string, window?: 'hour'|'day' } }} notice
     * @returns {Promise<number>} how many notifications were created
     */
    async function notify(orgId, { category, title, message, link = null, dedupe = null }) {
        const store = d.notificationStore();
        if (!orgId || !store?.createNotification) return 0;
        try {
            if (!(await _claim(orgId, dedupe))) return 0;
            const ids = await recipients(orgId);
            let sent = 0;
            for (const userId of ids) {
                try {
                    await store.createNotification({ userId, category, title, message, link });
                    sent++;
                } catch { /* one failed insert must not cost the others their notice */ }
            }
            return sent;
        } catch (e) {
            log.warn('[ComplianceNotices] notify failed:', e?.message || e);
            return 0;
        }
    }

    return { recipients, notify };
}

const _default = makeAdminNotices();

module.exports = {
    makeAdminNotices,
    recipients: _default.recipients,
    notify: _default.notify,
    RECIPIENT_SQL,
    _windowKey,
};
