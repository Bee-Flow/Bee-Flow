/**
 * NC onboarding-incomplete reminder (daily tick).
 *
 * An abandoned onboarding wizard silently zeroes out a whole org: non-admins
 * get 403 NC_ONBOARDING_PENDING on every request and admins see the wizard
 * instead of chat. This job nudges the org admins of every Nextcloud-bound
 * org that was provisioned > 3 days ago but never completed onboarding.
 *
 * Dedup: max one reminder per org per 7 days via a configStore marker
 * (`nc_onboarding_reminder_last_<orgId>` = ISO timestamp), so reboots and
 * multi-replica double-ticks don't spam admins. The marker is only advanced
 * after at least one notification was actually delivered.
 *
 * Audit: every delivered reminder writes a metadata-only
 * access_audit_log row ('nc_onboarding_reminder_sent') — org id + day count,
 * never message content or keys.
 *
 * run() never throws (scheduler-safe). Scheduling mirrors ncSyncBackstop:
 * start() from server/index.js, staggered first run, unref'd interval.
 */
const log = require('../telemetry/log');

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_AGE_DAYS = 3;         // orgs younger than this are still "just installed"
const REPEAT_EVERY_DAYS = 7;    // max one reminder per org per week
const TICK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const MARKER_PREFIX = 'nc_onboarding_reminder_last_';

// Same org-admin resolution as compliance/events.js _notifyAdmins:
// 'org_admin' is canonical; legacy 'admin' orgRole and global role='admin'
// members kept for orgs that pre-date the rename.
const ADMIN_SQL = `SELECT id FROM users WHERE "organizationId" = $1 AND (role = 'admin' OR "orgRole" IN ('org_admin', 'admin'))`;

function _isEligible(org, now) {
    if (!org || !org.nc_instance_id) return false;
    if (org.nc_onboarding_completed_at) return false;
    if (!org.nc_provisioned_at) return false;
    const provisionedAt = new Date(org.nc_provisioned_at).getTime();
    if (!Number.isFinite(provisionedAt)) return false;
    return (now - provisionedAt) > MIN_AGE_DAYS * DAY_MS;
}

async function run({ now = Date.now() } = {}) {
    const result = { checked: 0, notified: 0, skipped: 0, errors: 0 };
    let orgs;
    try {
        orgs = await require('../stores/userStore').getAllOrganizations();
    } catch (err) {
        log.warn(`[ncOnboardingReminder] Could not list orgs: ${err.message}`);
        return result;
    }

    const eligible = (orgs || []).filter(o => _isEligible(o, now));
    for (const org of eligible) {
        result.checked++;
        try {
            const configStore = require('../stores/configStore');
            const markerKey = `${MARKER_PREFIX}${org.id}`;

            // Dedup: skip when a reminder went out less than 7 days ago.
            const marker = await configStore.getConfig(markerKey);
            if (marker) {
                const last = new Date(String(marker)).getTime();
                if (Number.isFinite(last) && (now - last) < REPEAT_EVERY_DAYS * DAY_MS) {
                    result.skipped++;
                    continue;
                }
            }

            const admins = await require('../db').getAll(ADMIN_SQL, [org.id]);
            if (!admins || admins.length === 0) {
                // Nobody to notify — leave the marker unset so a future admin
                // is reminded on the next tick.
                result.skipped++;
                continue;
            }

            const daysSinceProvision = Math.floor((now - new Date(org.nc_provisioned_at).getTime()) / DAY_MS);
            const notificationStore = require('../stores/notificationStore');
            let sent = 0;
            for (const admin of admins) {
                try {
                    await notificationStore.createNotification({
                        userId: admin.id,
                        category: 'urgent',
                        title: 'Finish your Bee Flow setup',
                        message: `The Nextcloud connection for "${org.name || org.id}" was set up ${daysSinceProvision} days ago, `
                            + 'but the onboarding wizard has not been completed yet — your users cannot use AI until it is. '
                            + 'Open Bee Flow to finish the setup wizard.',
                        // The SPA shows the onboarding wizard to org admins at
                        // the app root while onboarding is incomplete.
                        link: require('../utils/appPaths').appRootPath(),
                    });
                    sent++;
                } catch (e) {
                    log.warn(`[ncOnboardingReminder] notify failed org=${org.id} user=${admin.id}: ${e.message}`);
                }
            }

            if (sent > 0) {
                result.notified++;
                // Metadata-only audit trail (best-effort by contract).
                await require('../stores/userStore').logAccessAudit(
                    'nc_onboarding_reminder_sent', 'organization', org.id,
                    'system:onboarding_reminder', null, { daysSinceProvision }, org.id
                );
                await configStore.setConfig(markerKey, new Date(now).toISOString());
            } else {
                result.errors++;
            }
        } catch (err) {
            result.errors++;
            log.warn(`[ncOnboardingReminder] org=${org.id} error: ${err.message}`);
        }
    }

    if (result.notified > 0) {
        log.info(`[ncOnboardingReminder] reminded=${result.notified} skipped=${result.skipped} errors=${result.errors}`);
    }
    return result;
}

let _interval = null;

function start() {
    if (_interval) return;
    // Stagger first run by 10 min after boot so we don't compete with init load.
    setTimeout(() => { run().catch(() => { }); }, 10 * 60 * 1000).unref?.();
    _interval = setInterval(() => { run().catch(() => { }); }, TICK_INTERVAL_MS);
    if (typeof _interval.unref === 'function') _interval.unref();
    log.info('[ncOnboardingReminder] Scheduled (daily; >3d incomplete onboarding; 1 reminder/org/7d)');
}

function stop() {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
    }
}

module.exports = { start, stop, run, _isEligible, MARKER_PREFIX };
