/**
 * The runner's reapers (extracted verbatim from automationRunner.js).
 *
 * Everything that cleans up after a run nobody is waiting on any more: rows
 * stuck in `running` after a crash, approvals and form waits past their
 * deadline, unclaimed form uploads, expired generated documents, and
 * transcriptions orphaned mid-pipeline. Mounted on the ticks in ./ticks.js.
 */

const automationStore = require('../../../stores/automationStore');
const notificationStore = require('../../../stores/notificationStore');
const runEventBus = require('../../runEventBus');
const { REAPER_FLOOR_MS, REAPER_BUFFER_MS, REAPER_MAX_ATTEMPTS } = require('../shared');
const log = require('../../../telemetry/log');

/**
 * Reaper — finds rows stuck in `running` longer than REAPER_STALE_AFTER_MS
 * (a runner crash / OOM / pod kill leaves them this way) and resets them
 * so the next tick can re-claim. After REAPER_MAX_ATTEMPTS the row is
 * left in `error` and the owner is notified.
 */
async function reapStuckAutomations() {
    try {
        const reaped = await automationStore.reapStuckAutomations({
            staleAfterMs: REAPER_FLOOR_MS,
            maxAttempts: REAPER_MAX_ATTEMPTS,
            bufferMs: REAPER_BUFFER_MS,
        });
        if (reaped.length === 0) return;
        for (const a of reaped) {
            const giveUp = (a.attempts || 0) >= REAPER_MAX_ATTEMPTS;
            log.warn(`[AutomationRunner] Reaper reset stuck row ${a.id} (attempts=${a.attempts}${giveUp ? ', giving up' : ''})`);
            if (giveUp) {
                try {
                    await notificationStore.createNotification({
                        userId: a.userId,
                        category: 'urgent',
                        title: `⚠️ Automation failed: ${a.title}`,
                        message: `The automation could not complete after ${REAPER_MAX_ATTEMPTS} attempts and was paused. Open it to inspect the last run.`,
                    });
                } catch (_) { /* non-fatal */ }
            }
        }
    } catch (e) {
        log.error('[AutomationRunner] reapStuckAutomations error:', e.message);
    }

    // §WS2.2 — separately expire approval-paused runs past their deadline. These
    // live on automation_runs (not the automations row reaped above), so the
    // stuck-row reaper never sees them. Own try block so a failure here doesn't
    // mask the stuck-row pass and vice-versa.
    try {
        const expired = await automationStore.reapExpiredApprovals();
        for (const r of expired) {
            log.warn(`[AutomationRunner] Reaper expired approval run ${r.id} (automation ${r.automationId})`);
            try {
                runEventBus.emitRunEvent('run.failed', {
                    runId: r.id, automationId: r.automationId, userId: r.userId,
                    status: 'error', errorClass: 'ApprovalExpired',
                    error: 'Approval expired — no decision was made before the deadline.',
                });
            } catch (_) { /* telemetry must never break the reaper */ }
        }
        // Flip the durable approval rows and TELL people. Expiry used to be
        // silent: the run died, and neither the owner nor the assignee heard
        // about it until they went looking. Also close pending rows whose run
        // is gone or no longer waiting (cancelled runs, pre-table decisions).
        try {
            const { expireApprovalsForReapedRuns, expireOverdueAppApprovals, remindAndEscalateDueApprovals } = require('../approvalLifecycle');
            await expireApprovalsForReapedRuns(expired);
            // App-sourced approvals have no run in `expired` to ride on —
            // their deadlines get their own sweep in the same tick.
            await expireOverdueAppApprovals();
            // Reminder + escalation clocks ride the same tick: conditional
            // UPDATEs claim each due row exactly once across pods.
            await remindAndEscalateDueApprovals();
            // Nextcloud 24–30 has the reactions API but no reaction WEBHOOKS
            // (those arrive with Nextcloud 31 / Talk 21), so a 👍 on an
            // approval card is only visible if we go and look. Bounded by the
            // still-pending queue, and a no-op on instances that never posted
            // a Talk card.
            try {
                const { pollTalkReactions } = require('../../../automation/approvalReactionIngest');
                const polled = await pollTalkReactions();
                if (polled.counted) {
                    log.info(`[AutomationRunner] Talk reaction poll recorded ${polled.counted} approval vote(s)`);
                }
            } catch (e) {
                log.warn('[AutomationRunner] Talk reaction poll error:', e.message);
            }
            const orphaned = await automationStore.cancelOrphanedPendingApprovals();
            for (const ap of orphaned) {
                await automationStore.appendApprovalAudit({
                    approvalId: ap.id, runId: ap.runId, stepId: ap.stepId,
                    decidedBy: null, decision: 'cancelled', source: 'reaper',
                }).catch(() => {});
                require('../../../automation/approvalEvents').dispatchApprovalDecided(ap);
            }
        } catch (e) {
            log.error('[AutomationRunner] approval lifecycle sweep error:', e.message);
        }
    } catch (e) {
        log.error('[AutomationRunner] reapExpiredApprovals error:', e.message);
    }

    // Same pass for runs paused on a multi-page form. The visitor closed the
    // tab, so nobody will ever submit the next page; without this the run and
    // its form session sit there until retention (which skips paused runs).
    try {
        const expired = await automationStore.reapExpiredFormWaits();
        for (const r of expired) {
            log.warn(`[AutomationRunner] Reaper expired form run ${r.id} (automation ${r.automationId})`);
            try {
                runEventBus.emitRunEvent('run.failed', {
                    runId: r.id, automationId: r.automationId, userId: r.userId,
                    status: 'error', errorClass: 'FormExpired',
                    error: 'Form expired — the next page was never submitted.',
                });
            } catch (_) { /* telemetry must never break the reaper */ }
        }
    } catch (e) {
        log.error('[AutomationRunner] reapExpiredFormWaits error:', e.message);
    }

    // §WS3.3 — reap orphaned run rows stuck in 'running' (worker died). Uses
    // last_heartbeat_at (a healthy long run heartbeats so it's never stale).
    try {
        const stuckRuns = await automationStore.reapStuckRuns({ staleAfterMs: REAPER_FLOOR_MS });
        for (const r of stuckRuns) {
            log.warn(`[AutomationRunner] Reaper failed stuck run ${r.id} (automation ${r.automationId}) — no heartbeat`);
            try {
                runEventBus.emitRunEvent('run.failed', {
                    runId: r.id, automationId: r.automationId, userId: r.userId,
                    status: 'error', errorClass: 'RunnerDied',
                    error: 'Run stopped heartbeating — the worker crashed or was killed.',
                });
            } catch (_) { /* telemetry must never break the reaper */ }
        }
    } catch (e) {
        log.error('[AutomationRunner] reapStuckRuns error:', e.message);
    }
}

/**
 * Delete the blobs behind expired, never-claimed form uploads and then their
 * ledger rows. Blob first: a row without bytes is a broken reference, but bytes
 * without a row are simply unreachable — so if we die in between, the next pass
 * retries and the worst case is an orphan blob, never a dangling descriptor.
 */
async function reapOrphanFormUploads() {
    try {
        const automationStore = require('../../../stores/automationStore');
        const rows = await automationStore.listExpiredFormUploads(200);
        if (!rows.length) return;
        const storageStore = require('../../../stores/storageStore');
        const reaped = [];
        for (const row of rows) {
            try {
                await storageStore.deleteFile(row.storageKey);
                reaped.push(row.id);
            } catch (e) {
                log.warn(`[AutomationRunner] form-upload blob delete failed (${row.id}): ${e.message}`);
            }
        }
        if (reaped.length) {
            await automationStore.deleteFormUploads(reaped);
            log.info(`[AutomationRunner] reaped ${reaped.length} unclaimed form upload(s)`);
        }
    } catch (e) {
        log.error('[AutomationRunner] form-upload reaper error:', e.message);
    }
}

/**
 * Delete documents a run produced once their retention window is up.
 *
 * Same order as the upload reaper and for the same reason: BLOB first, ROW
 * second. A live row with no bytes serves a clean 404 (the download route
 * treats a missing object as "not found"), while a live blob with no row is
 * unreachable garbage nothing will ever come back for.
 *
 * On a privacy product this is not housekeeping — it is the thing that makes
 * `expiresInDays` mean something.
 */
async function reapExpiredGeneratedFiles() {
    try {
        const automationStore = require('../../../stores/automationStore');
        const rows = await automationStore.listExpiredGeneratedFiles(200);
        if (!rows.length) return;
        const storageStore = require('../../../stores/storageStore');
        const reaped = [];
        for (const row of rows) {
            try {
                await storageStore.deleteFile(row.storageKey);
                reaped.push(row.id);
            } catch (e) {
                log.warn(`[AutomationRunner] generated-file blob delete failed (${row.id}): ${e.message}`);
            }
        }
        if (reaped.length) {
            await automationStore.deleteGeneratedFiles(reaped);
            log.info(`[AutomationRunner] reaped ${reaped.length} expired generated document(s)`);
        }
    } catch (e) {
        log.error('[AutomationRunner] generated-file reaper error:', e.message);
    }
}

// Meeting-notes reaper: flip transcriptions stuck in 'processing' (e.g. a pod
// restarted mid-pipeline) to 'failed' so the UI stops spinning. The UPDATE is
// idempotent and multi-pod safe; the list route also fires it opportunistically,
// but a note orphaned on a quiet instance shouldn't wait for someone to open
// the list.
async function reapStuckTranscriptions() {
    try {
        await require('../../../stores/transcriptionStore').timeoutStuckTranscriptions();
    } catch (e) {
        log.error('[AutomationRunner] transcription-reaper error:', e.message);
    }
}

module.exports = {
    reapStuckAutomations,
    reapOrphanFormUploads,
    reapExpiredGeneratedFiles,
    reapStuckTranscriptions,
};
