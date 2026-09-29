/**
 * approvalReactionIngest — a 👍 in Nextcloud Talk becomes a real vote.
 *
 * The card posted by approvalDelivery.js lives in a Talk conversation. What
 * comes back is `talk.reaction.added`, forwarded by the ExApp connector to
 * POST /api/automation/events/nextcloud. It says: someone reacted with an
 * emoji to message N in room T. Turning that into a decision takes four
 * separate proofs, and dropping any one of them turns a chat room into an
 * approval bypass:
 *
 *   1. THE MESSAGE IS OURS.       The connector's forward is HMAC-signed with
 *      the org tenant key and verified in events.js before this is ever
 *      called (which is itself downstream of Talk's own bot signature, checked
 *      in the connector against the bot secret). Beyond that, (roomToken,
 *      messageId) must resolve to a delivery-ledger row — a reaction on any
 *      other message in the room resolves to nothing.
 *   2. THE ROW IS STILL OPEN.     A decided/expired/withdrawn approval takes
 *      no votes, and the ledger row's org must match the org that signed.
 *   3. THE PERSON IS SOMEONE.     The Nextcloud uid must map to a Bee Flow
 *      user in THAT org (userStore.getUserByNcUid — the mapping ncUserGroupSync
 *      maintains). An unmapped actor — a guest, a federated user, our own bot's
 *      seeded 👍 — is not a person we can hold to a decision.
 *   4. THE PERSON HOLDS A SEAT.   Not "can see it", not "is an admin": a seat
 *      in the approval's CURRENT stage. Being asked later is not being asked
 *      now. Org-admin rights are deliberately NOT honoured here — an admin
 *      idly reacting in a shared room must not silently approve someone else's
 *      invoice, and they still have the full in-app decision path.
 *
 * The decision itself goes through approvalService.decide — the single place
 * a decision happens, which owns the deadline check, the one-decision-ever
 * conditional UPDATE, seat/stage assignment, the run resume, the audit row and
 * the on_decided hook. There is no second decision path here, and there must
 * never be one.
 *
 * ── Why 👎 is not a decline ────────────────────────────────────────────────
 * decide() refuses a rejection without a reason. A reaction carries none, so
 * 👎 answers with the deep link instead of a rejection — the same thing the
 * card already says. Approvals carrying approver questions take that route for
 * 👍 too: answers are coerced against the snapshot and an emoji answers
 * nothing.
 *
 * ── Silence is a security property ─────────────────────────────────────────
 * A reaction from someone who holds no seat is ignored WITHOUT a reply. The
 * card sits in a shared conversation; answering "you are not an approver"
 * would publish the approver list to the room.
 */

const automationStore = require('../stores/automationStore');
const log = require('../telemetry/log');

/**
 * Emoji that mean yes / no. Compared after normalisation, so 👍🏽 and 👍️ are
 * the same vote. Anything else is not an answer and is ignored outright — a
 * 🎉 on an approval card must never be a decision.
 */
const APPROVE_EMOJI = new Set(['👍', '✅', '☑️', '✔️', '🆗']);
const REJECT_EMOJI = new Set(['👎', '❌', '⛔', '🚫']);

/** Strip skin-tone modifiers (U+1F3FB–U+1F3FF) and the variation selector. */
function normalizeEmoji(raw) {
    return String(raw || '')
        .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')
        .replace(/[\uFE0E\uFE0F]/g, '')
        .trim();
}

function classifyReaction(raw) {
    const e = normalizeEmoji(raw);
    if (!e) return null;
    for (const yes of APPROVE_EMOJI) if (normalizeEmoji(yes) === e) return 'approve';
    for (const no of REJECT_EMOJI) if (normalizeEmoji(no) === e) return 'reject';
    return null;
}

/**
 * The viewer a REACTION speaks for. Deliberately narrower than the session
 * viewer routes/automation/approvals.js builds: no org-admin capability, so
 * canDecide's admin clause cannot fire from a chat room.
 */
async function reactionViewer(user) {
    const { parseGroupIds } = require('../auth/orgMembership');
    return {
        userId: user.id,
        groupIds: parseGroupIds(user).map(String),
        isOrgAdminOfOrg: () => false,
    };
}

/**
 * Does this reactor hold a seat that may act RIGHT NOW?
 *
 * Staged rows ask only the current stage (approvalService.isSeatedInStage over
 * approvalService.currentStage). Legacy panel and single-assignee rows reuse
 * approvalService.canDecide unchanged — with the admin clause disarmed by the
 * viewer above. One rulebook, no second copy of the seat arithmetic.
 */
function seatedNow(approval, viewer) {
    const approvalService = require('./approvalService');
    if (approvalService.hasStages(approval)) {
        const stage = approvalService.currentStage(approval);
        return !!stage && approvalService.isSeatedInStage(stage, viewer);
    }
    return approvalService.canDecide(approval, viewer);
}

/** The deep link, as the card prints it. */
function approvalLink(approvalId) {
    return require('./publicUrl').approvalUrlForId(approvalId);
}

async function nudgeToApp({ delivery, approval, reason }) {
    try {
        const { replyInTalk } = require('./approvalDelivery');
        await replyInTalk({
            orgId: delivery.organizationId,
            ownerId: approval.ownerId,
            roomToken: delivery.externalRef?.roomToken,
            replyTo: delivery.externalRef?.messageId ? Number(delivery.externalRef.messageId) : null,
            message: `${reason}\n👉 ${approvalLink(approval.id)}`,
        });
    } catch (e) {
        log.warn(`[ApprovalReactions] reply failed for ${approval.id}: ${e.message}`);
    }
}

/**
 * Handle one inbound `talk.reaction.added`.
 *
 * Never throws — the caller is a webhook ack path. Returns a small verdict
 * object; `counted: true` means a vote reached approvalService.decide.
 *
 * @param {{orgId:string, ncUid:string|null, payload:object}} p
 */
async function handleTalkReaction({ orgId, ncUid = null, payload = {} }) {
    const verdict = (outcome, extra = {}) => ({ counted: false, outcome, ...extra });
    try {
        if (!orgId) return verdict('no_org');
        // A removed reaction is not an un-vote: approvalService has one
        // decision, ever, and withdrawing a cast vote is an in-app action with
        // an audit trail. Taking the 👍 away changes nothing.
        if (payload?.removed) return verdict('reaction_removed');

        const decision = classifyReaction(payload?.reaction);
        if (!decision) return verdict('not_a_decision_emoji');

        // Only a real person votes. Talk reports the attendee kind on the
        // reaction ('users' | 'guests' | 'bots'); a guest holds no seat and a
        // bot reaction is our own seeded 👍 coming back at us. Absent on older
        // connector builds, in which case step (3) below still refuses anyone
        // who does not map to a Bee Flow user.
        if (payload?.actorType && payload.actorType !== 'users') return verdict('actor_not_a_user');

        const roomToken = payload?.roomToken || null;
        const messageId = payload?.messageId ?? null;
        if (!roomToken || messageId == null) return verdict('incomplete_payload');

        // (1) Is this one of our cards?
        const delivery = await automationStore.getApprovalDeliveryForTalkMessage(roomToken, messageId);
        if (!delivery) return verdict('not_an_approval_card');
        // The org that signed the forward must be the org the card was sent
        // for — otherwise one tenant's connector could vote on another's card.
        if (delivery.organizationId && String(delivery.organizationId) !== String(orgId)) {
            log.warn(`[ApprovalReactions] org mismatch for delivery ${delivery.id} — dropping`);
            return verdict('org_mismatch');
        }

        // (2) Is the row still open?
        const approval = await automationStore.getApproval(delivery.approvalId);
        if (!approval) return verdict('approval_gone');
        if (approval.status !== 'pending') return verdict('already_decided', { status: approval.status });

        // (3) Who reacted?
        const uid = ncUid || payload?.actor || null;
        if (!uid) return verdict('no_actor');
        const userStore = require('../stores/userStore');
        const user = await userStore.getUserByNcUid(orgId, uid).catch(() => null);
        if (!user?.id) return verdict('actor_not_a_beeflow_user');

        // (4) Do they hold a seat that may act now?
        const viewer = await reactionViewer(user);
        if (!seatedNow(approval, viewer)) return verdict('not_seated');

        // ── 👎 and question-carrying requests go to the app ──────────────
        if (decision === 'reject') {
            await nudgeToApp({
                delivery, approval,
                reason: 'Declining needs a reason, so it has to be done in Bee Flow.',
            });
            return verdict('reject_needs_reason');
        }
        if (Array.isArray(approval.fields) && approval.fields.length) {
            await nudgeToApp({
                delivery, approval,
                reason: 'This request asks a few questions — approve it in Bee Flow so the answers come with it.',
            });
            return verdict('answers_required');
        }

        // ── The decision. THE existing path, not a parallel one. ─────────
        const approvalService = require('./approvalService');
        const run = approval.runId ? await automationStore.getRun(approval.runId).catch(() => null) : null;
        const { code, body } = await approvalService.decide({
            approval,
            run,
            deciderId: user.id,
            decision: 'approve',
            source: 'nextcloud',
        });
        const ok = code >= 200 && code < 300;
        if (!ok) {
            // 403/409/410 are ordinary outcomes here (seat already used, row
            // decided in the meantime, deadline passed). Logged, not shouted,
            // and never answered in the room.
            log.info(`[ApprovalReactions] ${approval.id}: decide returned ${code} for ${user.id}`);
        }
        return { counted: ok, outcome: ok ? 'vote_recorded' : 'decide_refused', code, decision: body?.decision || null };
    } catch (e) {
        log.warn(`[ApprovalReactions] reaction handling failed: ${e.message}`);
        return verdict('error', { error: e.message });
    }
}

/**
 * POLLING fallback — for Nextcloud 24–30, where a bot receives no reaction
 * webhooks (those need Nextcloud 31 / Talk 21 and the bot's `reaction`
 * feature) but `GET /ocs/v2.php/apps/spreed/api/v1/reaction/{token}/{messageId}`
 * has existed since Nextcloud 24.
 *
 * Reads the reactions on every card still attached to a PENDING approval and
 * feeds each one through exactly the same handleTalkReaction path, so the four
 * proofs above apply identically whether a vote arrived by push or by poll.
 * Idempotent by construction: a 👍 already counted hits the one-decision-ever
 * guard (or the per-seat vote uniqueness index) and is refused, so re-reading
 * the same reaction every sweep costs a lookup and changes nothing.
 *
 * Bounded by "approvals still waiting", so on an instance with an empty queue
 * — or with no Talk cards at all — this does one indexed query and returns.
 */
async function pollTalkReactions({ limit = 200, budgetMs = 20_000, now = () => Date.now() } = {}) {
    // A WALL-CLOCK BUDGET, not just a row limit. `limit` bounds how many cards
    // we look at; it does not bound how long looking takes, and every one of
    // them is an outbound request to somebody else's Nextcloud. At 200 cards
    // against a server that has gone slow, this function is the whole 60-second
    // reaper tick and then some (the scheduler's nonOverlapping guard then
    // skips ticks, which is safe but means nothing else in the sweep runs).
    //
    // So stop at the budget and leave the rest pending. Nothing is lost: the
    // deliveries stay in the queue and the next tick picks up where this one
    // stopped. `now` is injectable so the deadline is testable without timers.
    const deadline = now() + budgetMs;
    let counted = 0;
    let checked = 0;
    let timedOut = false;
    let deliveries = [];
    try {
        deliveries = await automationStore.getPendingTalkDeliveries(limit);
    } catch (e) {
        log.warn(`[ApprovalReactions] poll query failed: ${e.message}`);
        return { checked: 0, counted: 0 };
    }
    if (!deliveries.length) return { checked: 0, counted: 0 };

    const { _deliveryTest: { resolveNcContext } } = require('./approvalDelivery');
    const { listMessageReactions } = require('../integrations/nextcloudTalkBot');
    // One Nextcloud identity per owner, not per card: a queue of ten approvals
    // from one owner must not rebuild the same session ten times.
    const contexts = new Map();

    for (const d of deliveries) {
        if (now() >= deadline) { timedOut = true; break; }
        const roomToken = d.externalRef?.roomToken;
        const messageId = d.externalRef?.messageId;
        if (!roomToken || messageId == null) continue;
        if (!contexts.has(d.userId)) {
            contexts.set(d.userId, await resolveNcContext(d.userId).catch(() => null));
        }
        const ctx = contexts.get(d.userId);
        if (!ctx) continue;
        checked += 1;

        const reactions = await listMessageReactions({
            ncFetch: ctx.fetch, baseUrl: ctx.baseUrl, roomToken, messageId,
        });
        for (const r of reactions) {
            // Guests and bots are not deciders — including our own seeded 👍.
            if (r.actorType && r.actorType !== 'users') continue;
            const res = await handleTalkReaction({
                orgId: d.organizationId,
                ncUid: r.actorId,
                payload: { roomToken, messageId, reaction: r.reaction, removed: false },
            });
            if (res.counted) counted += 1;
        }
    }
    if (timedOut) {
        log.warn(`[ApprovalReactions] poll hit its ${budgetMs}ms budget after ${checked} card(s) — remainder rides the next tick`);
    }
    return { checked, counted, timedOut };
}

module.exports = {
    APPROVE_EMOJI,
    REJECT_EMOJI,
    normalizeEmoji,
    classifyReaction,
    handleTalkReaction,
    pollTalkReactions,
    _ingestTest: { seatedNow, reactionViewer },
};
