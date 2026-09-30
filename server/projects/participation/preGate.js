// @typecheck
/**
 * The cheap rules in front of the relevance gate: no model call, no I/O, just
 * the facts the caller already holds. They run twice:
 *
 *   stage 'post'  when a human message is stored, to decide whether to start
 *                 (or push back) the debounced watch at all;
 *   stage 'job'   when the watch comes due, over the conversation as it is
 *                 then, with the caps and the turn lock added.
 *
 * The first rule that says no wins, and its name is the `skip_reason` the
 * decision log keeps. Every rule can only turn "maybe" into "no": nothing here
 * can make the AI speak where a rule forbids it, and the model behind the gate
 * can in turn only say no to what these rules let through.
 *
 * A message, as the rules see it:
 *   { id, seq, authorKind: 'user'|'assistant'|'system', authorUserId, text,
 *     createdAt (ISO), replyTo, mentionsAi, mentionsHuman }
 * `recent` is the conversation around it, ascending, deleted messages left
 * out, the message itself included.
 */

'use strict';

const { autoAllowedOn } = require('./policy');

const MINUTE = 60_000;
/** A reply to another person within this window is aimed at that person. */
const REPLY_TO_PERSON_MS = 5 * MINUTE;
/** Humans taking turns inside this window are talking to each other. */
const CONVERSING_WINDOW_MS = 3 * MINUTE;
/** At most this many words, without a question mark, reads as "ok", "thanks!". */
const ACK_MAX_TOKENS = 3;

const SKIP = Object.freeze({
    NOT_HUMAN: 'not_human',
    MODE: 'mode_not_auto',
    ORG_DISABLED: 'org_disabled',
    OPTED_OUT: 'author_opted_out',
    CLOSED: 'closed',
    PAUSED: 'paused',
    EXPLICIT: 'explicit_request',
    ADDRESSED_TO_PERSON: 'addressed_to_person',
    REPLY_TO_PERSON: 'reply_to_person',
    HUMANS_CONVERSING: 'humans_conversing',
    ACKNOWLEDGEMENT: 'acknowledgement',
    AI_SPOKE_LAST: 'ai_spoke_last',
    TRIGGER_GONE: 'trigger_gone',
    MOVED_ON: 'conversation_moved_on',
    ANSWERED: 'answered_by_member',
    COOLDOWN: 'cooldown',
    CHAT_HOUR_CAP: 'chat_hour_cap',
    PROJECT_DAY_CAP: 'project_day_cap',
    GATE_CHAT_CAP: 'gate_chat_cap',
    GATE_ORG_CAP: 'gate_org_cap',
    BUSY: 'busy',
});

const timeOf = (iso) => {
    const t = typeof iso === 'number' ? iso : Date.parse(String(iso || ''));
    return Number.isFinite(t) ? t : 0;
};

const QUESTION = /[?？¿؟]/;
const WORD = /[\p{L}\p{N}]/u;

/**
 * "ok", "thanks!", "👍", "sounds good" — a message that asks for nothing.
 * @param {string} text
 */
function isAcknowledgement(text) {
    const flat = String(text || '').trim();
    if (!flat) return true;
    if (!WORD.test(flat)) return true; // only emoji or punctuation
    if (QUESTION.test(flat)) return false;
    return flat.split(/\s+/).filter(Boolean).length <= ACK_MAX_TOKENS;
}

/**
 * Are two or more people taking turns right before this message? A→B→A
 * within the window, counted after the AI's last word.
 *
 * @param {Array<{ authorKind: string, authorUserId: string|null, createdAt: string }>} recent
 * @param {{ authorUserId: string|null, createdAt: string }} message
 */
function humansAlternating(recent, message) {
    const at = timeOf(message.createdAt);
    const turns = [];
    for (const m of recent) {
        if (timeOf(m.createdAt) > at) break;
        if (m.authorKind === 'assistant') { turns.length = 0; continue; }
        if (m.authorKind !== 'user') continue;
        if (at - timeOf(m.createdAt) > CONVERSING_WINDOW_MS) continue;
        turns.push(m.authorUserId);
    }
    let switches = 0;
    for (let i = 1; i < turns.length; i++) if (turns[i] !== turns[i - 1]) switches++;
    return switches >= 2 && new Set(turns).size >= 2;
}

/**
 * Is this a reply to another person's recent message?
 * @param {Array<{ id: string, authorKind: string, authorUserId: string|null, createdAt: string }>} recent
 * @param {{ replyTo?: string|null, authorUserId: string|null, createdAt: string }} message
 */
function repliesToPerson(recent, message) {
    if (!message.replyTo) return false;
    const target = recent.find((m) => m.id === message.replyTo);
    if (!target || target.authorKind !== 'user') return false;
    if (target.authorUserId === message.authorUserId) return false;
    return timeOf(message.createdAt) - timeOf(target.createdAt) <= REPLY_TO_PERSON_MS;
}

/**
 * The count caps and the cooldown, from the decision log.
 *
 * @param {{ lastReplyAt?: string|null, autoInChatHour?: number, autoInProjectDay?: number,
 *           gatesInChatHour?: number, gatesInOrgDay?: number }|null|undefined} caps
 * @param {{ cooldownMinutes: number, maxAutoPerChatHour: number, maxAutoPerProjectDay: number,
 *           maxGatesPerChatHour: number, maxGatesPerOrgDay: number }} policy
 * @param {number} now
 * @returns {string|null} the cap that is reached, or null
 */
function capReached(caps, policy, now) {
    if (!caps) return null;
    if (caps.lastReplyAt && now - timeOf(caps.lastReplyAt) < policy.cooldownMinutes * MINUTE) return SKIP.COOLDOWN;
    if ((caps.autoInChatHour || 0) >= policy.maxAutoPerChatHour) return SKIP.CHAT_HOUR_CAP;
    if ((caps.autoInProjectDay || 0) >= policy.maxAutoPerProjectDay) return SKIP.PROJECT_DAY_CAP;
    if ((caps.gatesInChatHour || 0) >= policy.maxGatesPerChatHour) return SKIP.GATE_CHAT_CAP;
    if ((caps.gatesInOrgDay || 0) >= policy.maxGatesPerOrgDay) return SKIP.GATE_ORG_CAP;
    return null;
}

/**
 * The rules. Returns `{ ok: true }` or `{ ok: false, reason }`.
 *
 * @param {object} p
 * @param {'post'|'job'} p.stage
 * @param {'quiet'|'unanswered'} [p.triggerKind]  'quiet' at the post stage
 * @param {number} p.now
 * @param {string} [p.surface]                    'chat' | 'comment'
 * @param {string} p.mode                         the conversation's AI mode
 * @param {boolean} [p.closed]                    archived chat, resolved thread
 * @param {string|null} [p.pausedUntil]           the "not helpful" back-off
 * @param {any} p.policy                          the org policy (policy.js)
 * @param {boolean} p.authorOptedOut
 * @param {any} p.message                         the trigger, as the header describes
 * @param {any[]} p.recent
 * @param {any} [p.caps]                          capsFor() from the store
 * @param {boolean} [p.lockHeld]                  an answer is being written now
 * @returns {{ ok: boolean, reason?: string }}  `reason` is set whenever `ok` is false
 */
function preGate(p) {
    const no = (reason) => ({ ok: false, reason });
    const { stage, now, message, recent = [], policy } = p;
    const triggerKind = p.triggerKind || 'quiet';

    if (!message) return no(SKIP.TRIGGER_GONE);
    if (message.authorKind !== 'user' || !message.authorUserId) return no(SKIP.NOT_HUMAN);
    if (p.mode !== 'auto') return no(SKIP.MODE);
    if (!autoAllowedOn(policy, p.surface || 'chat')) return no(SKIP.ORG_DISABLED);
    if (p.authorOptedOut) return no(SKIP.OPTED_OUT);
    if (p.closed) return no(SKIP.CLOSED);
    if (p.pausedUntil && timeOf(p.pausedUntil) > now) return no(SKIP.PAUSED);

    const later = recent.filter((m) => timeOf(m.createdAt) > timeOf(message.createdAt)
        || (Number.isFinite(m.seq) && Number.isFinite(message.seq) && m.seq > message.seq));

    if (triggerKind === 'unanswered') {
        // The question had its quiet check already; now it only has to still be open.
        if (!recent.some((m) => m.id === message.id)) return no(SKIP.TRIGGER_GONE);
        if (later.some((m) => m.authorKind === 'assistant')) return no(SKIP.AI_SPOKE_LAST);
        if (later.some((m) => m.authorKind === 'user'
            && (m.authorUserId !== message.authorUserId || m.replyTo === message.id))) return no(SKIP.ANSWERED);
    } else {
        if (message.mentionsAi) return no(SKIP.EXPLICIT);
        if (message.mentionsHuman) return no(SKIP.ADDRESSED_TO_PERSON);
        if (repliesToPerson(recent, message)) return no(SKIP.REPLY_TO_PERSON);
        if (humansAlternating(recent, message)) return no(SKIP.HUMANS_CONVERSING);
        if (isAcknowledgement(message.text)) return no(SKIP.ACKNOWLEDGEMENT);
        if (stage === 'job') {
            if (later.some((m) => m.authorKind === 'assistant')) return no(SKIP.AI_SPOKE_LAST);
            // A newer human message did not pass these rules when it was
            // posted (it would have become the watch's trigger otherwise):
            // the conversation has moved on between people.
            if (later.some((m) => m.authorKind === 'user')) return no(SKIP.MOVED_ON);
        }
    }

    const cap = capReached(p.caps, policy, now);
    if (cap) return no(cap);
    if (stage === 'job' && p.lockHeld) return no(SKIP.BUSY);
    return { ok: true };
}

module.exports = {
    SKIP,
    REPLY_TO_PERSON_MS,
    CONVERSING_WINDOW_MS,
    preGate,
    isAcknowledgement,
    humansAlternating,
    repliesToPerson,
    capReached,
};
