/**
 * approvalAnnouncement: the words an approval request carries once it leaves
 * Bee Flow.
 *
 * Personal data leaves Bee Flow by e-mail only (BFSF-441). A Talk card and a
 * Nextcloud bell therefore carry the routine's name, the event ("approval
 * needed"), the role the request is asked of, a link, and nothing else. Never
 * the prompt (it quotes run data), the details, the approver questions or
 * their answers, the attachments, or the request context. The in-app bell and
 * the e-mail keep the prompt; those are built elsewhere.
 *
 * ── Allow-list, not a blacklist ────────────────────────────────────────────
 * approvalAnnouncement() READS the approval row and COPIES OUT the few fields
 * named below; the renderers see only that frozen object, never the row. A
 * column added to the approval row next year therefore stays inside Bee Flow
 * until someone adds it here on purpose.
 */

'use strict';

const { shortMessage } = require('./notificationMessages');

/** Emoji the card asks for. Kept next to the ingest's allowlist by tests. */
const APPROVE_EMOJI = '👍';
const REJECT_EMOJI = '👎';

/** The only keys an announcement has. A test pins this list. */
const ANNOUNCEMENT_FIELDS = Object.freeze([
    'event', 'code', 'routineName', 'headline', 'role', 'answerInApp', 'link',
]);

/** Designer-written text fit for one line: trimmed, no line breaks, capped. */
function oneLine(text, max = 120) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Who the request is asked of, in role terms: the stage name the routine's
 * designer gave it (never its free-text description), else the kind of
 * assignee. Never a person's name.
 */
function roleWording({ approval, stage = null, position = null }) {
    if (stage) {
        const where = position ? `Step ${position.index} of ${position.total}` : 'Approval step';
        const name = oneLine(stage.name);
        return name ? `${where}: ${name}` : where;
    }
    if (Array.isArray(approval?.approvers) && approval.approvers.length) return 'Asked of the approval panel';
    if (approval?.assigneeGroupId) return 'Asked of the assigned group';
    if (approval?.assigneeUserId) return 'Asked of the assigned approver';
    return 'Asked of the routine owner';
}

/**
 * The allow-listed announcement for one approval request.
 *
 * @param {object} p
 * @param {object} p.approval          the approval row (read, never passed on)
 * @param {string} [p.automationTitle] the routine's name, when the caller has it
 * @param {string} [p.url]             the deep link into Bee Flow
 * @param {object} [p.stage]           the current stage of a chain
 * @param {{ index: number, total: number }} [p.position]
 */
function approvalAnnouncement({ approval, automationTitle = '', url = null, stage = null, position = null }) {
    const short = shortMessage({ event: 'onApproval', title: automationTitle || approval?.automationTitle || '' });
    return Object.freeze({
        event: 'approval_needed',
        code: short.code,
        routineName: short.params.name,
        headline: short.text,
        role: roleWording({ approval, stage, position }),
        // Whether the request has approver questions, as a yes/no. The
        // questions themselves stay in Bee Flow.
        answerInApp: Array.isArray(approval?.fields) && approval.fields.length > 0,
        link: typeof url === 'string' && url ? url : null,
    });
}

/**
 * The Talk card, from an announcement only. Markdown, because Talk renders
 * it; short, because a chat message that needs scrolling is not a card.
 *
 * `answerInApp` is the honesty switch: when the request carries approver
 * questions, 👍 cannot answer them, so the card must not offer it.
 */
function renderTalkCard(a) {
    const lines = [`🛂 **${a.headline}**`, `_${a.role}_`, ''];
    if (a.answerInApp) {
        // Stated as a property of THIS request, not as a missing feature.
        lines.push('This request asks a few questions, so it has to be answered in Bee Flow. A reaction cannot carry the answers.');
    } else {
        lines.push(`React ${APPROVE_EMOJI} to approve.`);
        lines.push(`To decline, open the request: declining needs a reason, and ${REJECT_EMOJI} cannot carry one.`);
    }
    lines.push('The details are in Bee Flow.');
    if (a.link) lines.push('', `👉 ${a.link}`);
    return lines.join('\n');
}

/** The Nextcloud bell, from an announcement only. */
function renderBell(a) {
    return {
        subject: a.headline,
        message: `${a.role}\nOpen it in Bee Flow.`,
        link: a.link,
    };
}

module.exports = {
    APPROVE_EMOJI,
    REJECT_EMOJI,
    ANNOUNCEMENT_FIELDS,
    approvalAnnouncement,
    renderTalkCard,
    renderBell,
};
