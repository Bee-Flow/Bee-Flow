/**
 * approvalDelivery — putting an approval card where the approver already is.
 *
 * The bell inside Bee Flow assumes the approver opens Bee Flow. For a customer
 * whose day happens in Nextcloud, that assumption is the whole friction. This
 * module delivers the same request into Nextcloud, on two channels with very
 * different honesty:
 *
 *   nc_talk          a card posted into a Talk conversation, where 👍 is a
 *                    REAL approve — the reaction comes back as a signed
 *                    webhook and is counted as a vote (see
 *                    approvalReactionIngest.js).
 *   nc_notification  the notification bell. PASSIVE by necessity: no external
 *                    service can attach action buttons to a Nextcloud
 *                    notification (INotification::addAction() is PHP-only, in
 *                    the server process). It carries a deep link and nothing
 *                    more — see integrations/nextcloudAdminNotify.js.
 *
 * ── The asymmetry, stated in the card ──────────────────────────────────────
 * 👍 approves; 👎 does NOT decline. approvalService.decide refuses a rejection
 * without a reason ("A reason is required to reject.") and a reaction carries
 * no text, so declining opens the link. The same applies to any approval whose
 * snapshot has approver QUESTIONS: answers are coerced against the snapshot,
 * and an emoji answers nothing. The card says both out loud — a capability the
 * reader has to discover by having it fail is a bug report waiting to happen.
 *
 * ── Delivery is best-effort, and the ledger says so ────────────────────────
 * Notification dispatch has no queue, no retry and no dead letter. Every
 * attempt — success or failure — writes a row into automation_approval_deliveries,
 * so "the card never arrived" has an answer. Nothing in here may throw into the
 * caller: an approval that cannot be announced must still exist.
 *
 * ── What the card and the bell say (BFSF-441) ──────────────────────────────
 * The routine's name, "approval needed", the role it is asked of and the
 * link: nothing else. Both texts are rendered from the allow-listed object
 * approvalAnnouncement.js builds, never from the approval row, so the prompt,
 * the details, the questions and the attachments stay in Bee Flow.
 */

const automationStore = require('../stores/automationStore');
const configStore = require('../stores/configStore');
const { approvalUrlForId } = require('./publicUrl');
const log = require('../telemetry/log');
const {
    APPROVE_EMOJI, REJECT_EMOJI, approvalAnnouncement, renderTalkCard, renderBell,
} = require('./approvalAnnouncement');

/** Org-level default conversation for approval cards (plain config, not a secret). */
function talkRoomConfigKey(orgId) {
    return `nc_approvals_talk_room_${orgId}`;
}

/**
 * Which Talk conversation does this approval's card belong in?
 *
 * Order: the automation's own setting → the request's own context (an App
 * Studio request_approval can name a room) → the org default. There is no
 * "guess a 1:1 room" fallback on purpose: a bot can only post into
 * conversations a moderator deliberately added it to, so an invented room
 * would 401, and posting as an impersonated user into someone's private chat
 * is a different product decision than the one this feature made.
 */
async function resolveTalkRoom({ automation = null, approval = null, orgId = null }) {
    // `talkRoom` is the handoff 5 name; `ncTalkRoom` what older routines stored.
    const onApproval = automation?.definition?.notificationSettings?.onApproval;
    const fromAutomation = onApproval?.talkRoom || onApproval?.ncTalkRoom;
    if (typeof fromAutomation === 'string' && fromAutomation.trim()) return fromAutomation.trim();
    const fromContext = approval?.context?.ncTalkRoom;
    if (typeof fromContext === 'string' && fromContext.trim()) return fromContext.trim();
    if (!orgId) return null;
    try {
        const cfg = await configStore.getConfig(talkRoomConfigKey(orgId));
        const token = typeof cfg === 'string' ? cfg : cfg?.token;
        return typeof token === 'string' && token.trim() ? token.trim() : null;
    } catch { return null; }
}

/** The stage a card is announcing, and where it sits in the chain. */
function stageContext(approval) {
    try {
        const approvalService = require('./approvalService');
        if (!approvalService.hasStages(approval)) return { stage: null, position: null };
        const stage = approvalService.currentStage(approval);
        if (!stage) return { stage: null, position: null };
        const { stagePosition } = require('./approvalStages');
        return { stage, position: stagePosition(approval.stages, stage.key) };
    } catch { return { stage: null, position: null }; }
}

/**
 * The Talk card for one approval: the allow-listed announcement, rendered.
 * The approval row goes in, but only the announcement's fields come out
 * (see approvalAnnouncement.js); the prompt never reaches Talk.
 */
function buildApprovalCard({ approval, automationTitle = '', url, stage = null, position = null }) {
    return talkCardText(approvalAnnouncement({ approval, automationTitle, url, stage, position }));
}

function talkCardText(announcement) {
    const { MAX_MESSAGE_CHARS } = require('../integrations/nextcloudTalkBot');
    // Backstop only: every part of the card is capped, so this never cuts.
    return clampText(renderTalkCard(announcement), MAX_MESSAGE_CHARS);
}

/**
 * `text` cut to at most `max` UTF-16 units, ending in '…' when cut. Never
 * splits a surrogate pair, so an emoji at the cut does not become mojibake.
 */
function clampText(text, max) {
    if (text.length <= max) return text;
    if (max <= 1) return '';
    let cut = text.slice(0, max - 1);
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    return `${cut}…`;
}

/**
 * A Nextcloud auth context for acting on behalf of `userId`, or null.
 *
 * Off the request path there is no session, so one is rebuilt the way every
 * other offline Nextcloud call in the runner does it (resolveUserSession →
 * resolveAuth), which covers the connector, OAuth and app-password modes
 * alike. Connector-bound orgs need no stored credentials at all, which is why
 * this works for a run that paused at 3am.
 */
async function resolveNcContext(userId) {
    if (!userId) return null;
    try {
        const { resolveUserSession } = require('../core/automationRunner/engine');
        const session = await resolveUserSession(userId).catch(() => null);
        const ncClient = require('../integrations/nextcloudClient');
        const ctx = await ncClient.resolveAuth(session, userId);
        return ctx && ctx.baseUrl && typeof ctx.fetch === 'function' ? ctx : null;
    } catch { return null; }
}

/**
 * The Nextcloud origin to talk to, with or without a user.
 *
 * The bot needs a URL and a secret — no session, no credentials, no user at
 * all. That is the whole point of it, and it is the case an admin lands in
 * after running `occ talk:bot:install` on an instance where nobody has
 * connected a personal Nextcloud account. So when there is no auth context,
 * fall back to the organisation's configured Nextcloud URL.
 */
async function resolveNcBaseUrl(ctx) {
    if (ctx?.baseUrl) return ctx.baseUrl;
    try {
        return await require('../integrations/nextcloudClient').getBaseUrl();
    } catch { return null; }
}

/**
 * Post a card into a Talk room and record what came back.
 *
 * Two posting identities, in order:
 *
 *   BOT   `POST /ocs/v2.php/apps/spreed/api/v1/bot/{token}/message`, signed
 *         HMAC-SHA256(RANDOM ‖ message). This is the product speaking, needs
 *         no user session, and is the identity the reaction contract is built
 *         around. It answers 201 with an EMPTY body, so the message id is
 *         recovered afterwards by matching our own referenceId in
 *         `GET /chat/{token}` — with whatever read auth exists.
 *   USER  `POST /ocs/v2.php/apps/spreed/api/v1/chat/{token}` as the owner,
 *         which returns the full message (id included). Used when the org has
 *         no bot secret — i.e. no admin ever ran `occ talk:bot:install`.
 *         Because this one IS the user's identity, it passes the Nextcloud
 *         scope guard first: posting into a room they excluded is a write into
 *         a room they asked Bee Flow to stay out of.
 *
 * A card with no recoverable message id is still a delivery — it carries the
 * deep link — it simply cannot count reactions, and the ledger row shows that
 * by having no messageId.
 */
async function postTalkCard({ orgId, roomToken, message, ownerId = null, silent = false, replyTo = null, ctx = undefined }) {
    const talkBot = require('../integrations/nextcloudTalkBot');
    const secret = await talkBot.getBotSecret(orgId);
    // Rebuilding an offline session is the expensive part of this path, so the
    // caller may hand one in — a delivery that posts a card, seeds a reaction
    // and rings three bells must not rebuild it five times.
    if (ctx === undefined) ctx = await resolveNcContext(ownerId);

    if (secret) {
        const baseUrl = await resolveNcBaseUrl(ctx);
        if (baseUrl) {
            const res = await talkBot.postBotMessage({
                baseUrl, secret, roomToken, message, replyTo, silent,
            }).catch(e => ({ ok: false, status: 0, error: e.message }));
            if (res.ok) {
                // The id lookup is a READ, which the bot has no surface for —
                // it needs a user/connector identity. Without one the card is
                // delivered and simply not reactable.
                const messageId = await talkBot.findMessageIdByReference({
                    ncFetch: ctx?.fetch, baseUrl, roomToken, referenceId: res.referenceId,
                });
                return { ok: true, via: 'bot', roomToken, messageId, referenceId: res.referenceId };
            }
            // Fall through to the user identity: a bot that is not enabled in
            // this conversation (401) is the single most likely
            // misconfiguration, and a card the owner can still post beats no
            // card at all.
            if (!ctx?.fetch) return { ok: false, via: 'bot', error: res.error };
        }
    }

    if (!ctx?.baseUrl || typeof ctx.fetch !== 'function') {
        return { ok: false, via: null, error: 'no Nextcloud identity available for this organisation' };
    }

    // The user-identity path is a real tool call in everything but name, so it
    // takes the same scope check the tool dispatcher applies.
    try {
        const { checkToolCall } = require('../core/integrations/ncScopeGuard');
        const denial = await checkToolCall({
            toolName: 'nextcloud_talk_send_message',
            toolArgs: { token: roomToken, message },
            userId: ownerId, orgId,
        });
        if (denial) return { ok: false, via: 'user', error: 'that conversation is outside this user’s Nextcloud access scope' };
    } catch { /* guard unavailable → the post below still carries user auth */ }

    try {
        const { TALK_V1 } = talkBot;
        const body = { message: String(message || ''), silent: !!silent };
        if (Number.isFinite(Number(replyTo)) && Number(replyTo) > 0) body.replyTo = Number(replyTo);
        const res = await ctx.fetch(`${ctx.baseUrl}${TALK_V1}/chat/${encodeURIComponent(roomToken)}?format=json`, {
            method: 'POST',
            headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok && res.status !== 201) {
            return { ok: false, via: 'user', error: `Talk refused the card (HTTP ${res.status})` };
        }
        const data = await res.json().catch(() => null);
        const id = data?.ocs?.data?.id;
        return { ok: true, via: 'user', roomToken, messageId: id != null ? String(id) : null };
    } catch (e) {
        return { ok: false, via: 'user', error: e.message };
    }
}

/**
 * Deliver one approval's card on the Nextcloud channels the policy selected.
 * Never throws; returns a small report the caller may log.
 *
 * @param {object}   p
 * @param {object}   p.approval      the durable approval row
 * @param {object}   [p.automation]  the automation it paused (for the title/room)
 * @param {string[]} p.channels      the resolved notification policy's channels
 * @param {string[]} [p.recipientIds] Bee Flow user ids the bell should reach
 */
async function deliverApprovalToNextcloud({ approval, automation = null, channels = [], recipientIds = [] }) {
    const report = { talk: null, notifications: [] };
    if (!approval?.id) return report;
    const wantTalk = channels.includes('nc_talk');
    const wantBell = channels.includes('nc_notification');
    if (!wantTalk && !wantBell) return report;

    const orgId = approval.organizationId || automation?.organizationId || null;
    const ownerId = approval.ownerId || automation?.userId || null;
    const url = approvalUrlForId(approval.id);
    const { stage, position } = stageContext(approval);
    const stageKey = stage?.key || approval.stage || null;
    // One Nextcloud identity for the whole delivery — see postTalkCard.
    const ctx = await resolveNcContext(ownerId);
    // Everything that leaves for Nextcloud is rendered from this, never from
    // the approval row (BFSF-441; approvalAnnouncement.js).
    const announcement = approvalAnnouncement({
        approval, automationTitle: automation?.title, url, stage, position,
    });

    if (wantTalk) {
        const roomToken = await resolveTalkRoom({ automation, approval, orgId });
        if (!roomToken) {
            report.talk = { ok: false, error: 'no Talk conversation configured for approval cards' };
        } else {
            const message = talkCardText(announcement);
            const res = await postTalkCard({ orgId, roomToken, message, ownerId, ctx })
                .catch(e => ({ ok: false, via: null, error: e.message }));
            report.talk = res;
            await automationStore.recordApprovalDelivery({
                approvalId: approval.id,
                stage: stageKey,
                channel: 'nc_talk',
                organizationId: orgId,
                userId: ownerId,
                externalRef: {
                    roomToken,
                    ...(res.messageId ? { messageId: String(res.messageId) } : {}),
                    ...(res.referenceId ? { referenceId: res.referenceId } : {}),
                    ...(res.via ? { via: res.via } : {}),
                },
                status: res.ok ? 'sent' : 'failed',
                error: res.ok ? null : (res.error || 'delivery failed'),
            }).catch(e => log.warn(`[ApprovalDelivery] ledger write failed for ${approval.id}: ${e.message}`));

            // Seed the 👍 so approving is one tap on an existing reaction
            // rather than a hunt through the emoji picker. Purely cosmetic —
            // a failure here changes nothing about who may decide.
            if (res.ok && res.messageId && res.via === 'bot') {
                try {
                    const talkBot = require('../integrations/nextcloudTalkBot');
                    const secret = await talkBot.getBotSecret(orgId);
                    if (secret && ctx?.baseUrl && !announcement.answerInApp) {
                        await talkBot.postBotReaction({
                            baseUrl: ctx.baseUrl, secret, roomToken,
                            messageId: res.messageId, reaction: APPROVE_EMOJI,
                        });
                    }
                } catch { /* the card stands without it */ }
            }
        }
    }

    if (wantBell) {
        const { sendAdminNotification } = require('../integrations/nextcloudAdminNotify');
        const userStore = require('../stores/userStore');
        const bell = renderBell(announcement);
        for (const userId of Array.isArray(recipientIds) ? recipientIds : []) {
            const user = await userStore.getUser(userId).catch(() => null);
            const ncUid = user?.nc_uid || user?.ncUid || null;
            if (!ncUid) continue;
            const res = ctx
                ? await sendAdminNotification({
                    ncFetch: ctx.fetch, baseUrl: ctx.baseUrl, ncUid,
                    subject: bell.subject, message: bell.message, link: bell.link,
                }).catch(e => ({ ok: false, apiVersion: null, status: 0, error: e.message }))
                : { ok: false, apiVersion: null, status: 0, error: 'no Nextcloud identity available for this organisation' };
            report.notifications.push({ userId, ncUid, ok: res.ok, apiVersion: res.apiVersion });
            await automationStore.recordApprovalDelivery({
                approvalId: approval.id,
                stage: stageKey,
                channel: 'nc_notification',
                organizationId: orgId,
                userId,
                ncUid,
                externalRef: { ncUid, ...(res.apiVersion ? { apiVersion: res.apiVersion } : {}) },
                status: res.ok ? 'sent' : 'failed',
                error: res.ok ? null : (res.error || 'delivery failed'),
            }).catch(() => {});
        }
    }

    return report;
}

/**
 * Reply into the conversation a card was posted in — the 👎 nudge and the
 * "counted it" acknowledgement. Best-effort and deliberately terse: chat noise
 * about approvals is the fastest way to get the bot removed from the room.
 */
async function replyInTalk({ orgId, roomToken, message, replyTo = null, ownerId = null }) {
    if (!roomToken || !String(message || '').trim()) return { ok: false, error: 'nothing to say' };
    return postTalkCard({ orgId, roomToken, message, ownerId, replyTo, silent: false })
        .catch(e => ({ ok: false, via: null, error: e.message }));
}

module.exports = {
    APPROVE_EMOJI,
    REJECT_EMOJI,
    talkRoomConfigKey,
    resolveTalkRoom,
    buildApprovalCard,
    postTalkCard,
    replyInTalk,
    deliverApprovalToNextcloud,
    // Run notifications (core/automationRunner/runNotifications.js) ring the
    // Nextcloud bell with the same offline identity.
    resolveNcContext,
    _deliveryTest: { stageContext, resolveNcContext },
};
