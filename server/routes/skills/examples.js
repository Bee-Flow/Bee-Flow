/**
 * Skill examples taken from a real conversation (Bee Flow Builder redesign,
 * Sep 2026; Skills artboard 1b, plan S2).
 *
 * Three handlers, wired into `routes/skills.js` (which owns the router, the
 * auth guards and the `manage_skills` gate):
 *
 *   GET  /api/skills/examples/conversations                       your own chats
 *   GET  /api/skills/examples/conversations/:conversationId/messages
 *   POST /api/skills/:id/examples/from-message
 *
 * They are plain `(req, res)` functions rather than a mounted sub-router,
 * and `routes/skills.js` requires this file LAZILY inside each route. That
 * is not a style choice: `routes/skills.test.js` stubs skills.js's own
 * dependencies through a `Module._resolveFilename` hook keyed on the
 * PARENT file, so anything this file requires would load for real the
 * moment skills.js is required — a DB-free test suite quietly growing a
 * database and a PII guard. Loading on first use keeps that suite exactly
 * as DB-free as it was.
 *
 * ── WHY THE CONVERSATION READ LIVES HERE ────────────────────────────
 * `agentStore.getConversationById` has NO owner filter (stores/agent/
 * agentConversations.js) — hand it an id and it returns the conversation,
 * whoever it belongs to. Every existing caller checks `user_id` itself, and
 * the one that forgets is an IDOR. So all three handlers read through ONE
 * helper, `ownConversation`, which does that check once; the client never
 * talks to the agents API for this at all, so there is one owner check to
 * get right instead of two.
 *
 * ── TWO LAYERS OF REDACTION, BOTH BEFORE ANYTHING IS SHOWN OR SAVED ─
 *   1. `{ restore: false }` — the conversation is read the way the model
 *      saw it, with Privacy Shield tokens still in place. Restoration
 *      exists for rendering a chat back to its own owner; an example is
 *      copied OUT of that context and read later by colleagues, so it must
 *      never carry the restored values.
 *   2. `detectPii` + `tokenizeText` on top, for whatever the token map
 *      missed (a conversation older than the shield, an org that switched
 *      it on last week). This is what the artboard's "personal data is
 *      removed automatically" promises — and it runs on the PREVIEW too,
 *      because a picker that shows raw names while promising to remove them
 *      would be the worst of both.
 *
 * Neither ownership NOR redaction fails open here. `detectPii` itself fails
 * open — it answers `null` with no guard installed, and a clean-LOOKING
 * `{ hasPii:false, entities:[], degraded:true }` when the guard is installed
 * but unreachable — so `redact` reports whether a scan actually ran, and the
 * two callers act on it: the preview withdraws the promise on screen, the
 * write refuses (503 `pii_unchecked`). A screen that says personal data is
 * removed automatically may not be storing text nothing looked at.
 *
 * `sourceConversationId` is provenance, not a link: the example is visible
 * to everyone who can see the skill, and most of them cannot open that chat.
 *
 * No request schema here, and none belongs here: routes/skills.js mounts these
 * handlers behind its own validate() schemas (FromMessageBody, TestBody,
 * DraftBody, ImproveBody), so every body read below has already been checked.
 */

'use strict';

/**
 * How many messages of one conversation are readable at all. The LAST ones:
 * the answer somebody wants to keep is the one that just happened, and a
 * head-first window made exactly that message unreachable in a long chat —
 * for the picker AND for the POST, which addresses messages through the same
 * helper and answered 400 `no_message` for anything past the cut.
 */
const MESSAGE_LIMIT = 200;
/**
 * How many of those the PICKER offers, most recent first.
 *
 * Every offered message costs one guard scan, and one click used to fire one
 * `detectPii` per readable message of the whole conversation — 200 of them,
 * on the interactive lane, in front of everybody else's chat on that pod
 * (BFSF-322 is why that lane exists). The picker only ever renders assistant
 * turns, so the user turns were scanned for nothing; those are dropped and
 * the rest is bounded here.
 */
const PREVIEW_LIMIT = 40;
/** How long one half of an example may be. Longer is a document. */
const MAX_EXAMPLE_CHARS = 4000;
/**
 * Cap on stored examples. NOT a second constant with its own number: the
 * validator refuses at `skillStructure.MAX_EXAMPLES` and a copy of that limit
 * drifted from 40 to 50 here, so a skill with 40-49 examples passed this gate
 * and then threw inside the store. Read it from the one place that owns it.
 */
const { MAX_EXAMPLES } = require('../../core/skills/skillStructure');
const log = require('../../telemetry/log');

async function orgIdOf(req) {
    const userStore = require('../../stores/userStore');
    const user = await userStore.getUser(req.session.user.id);
    return user?.organizationId || null;
}

/**
 * The caller's own conversation, or null. This `user_id` comparison is the
 * whole security boundary of this file.
 *
 * ── WHY THE THROW IS CAUGHT, AND WHY THAT IS NOT FAILING OPEN ───────
 * `getConversationById` decrypts the messages BEFORE anyone compares
 * `user_id`, and on a zero-knowledge org the key it uses is the CALLER'S
 * (messageCrypto: `key = _toKeyBuffer(encryptionKey)`). Somebody else's
 * conversation therefore does not open — it throws FIELD_DECRYPT_FAILED,
 * deliberately (agentConversations.js), and an uncaught throw here became a
 * 500 while a made-up id got a 404. That difference is an existence oracle:
 * ask for a thousand ids and the 500s are the ones that exist in other
 * accounts. `managed` tier hid it, because there the ESCROW key of the row's
 * owner opens the row and the `user_id` check below is what refuses.
 *
 * So a failed read answers the same as "not there". That is the CLOSED
 * direction: null means the caller gets nothing. It costs one honest case —
 * the caller's OWN conversation with a broken key also reads as absent — and
 * that case is already unusable, while the alternative leaks who owns what.
 */
async function ownConversation(req, conversationId) {
    if (!conversationId || typeof conversationId !== 'string') return null;
    const agentStore = require('../../stores/agentStore');
    let conv = null;
    try {
        conv = await agentStore.getConversationById(
            conversationId,
            req.session?.encryptionKey,
            { restore: false },
        );
    } catch (err) {
        log.warn('[Skills] examples: conversation read refused for', conversationId, '-', err?.code || err?.message);
        return null;
    }
    if (!conv) return null;
    if (conv.user_id !== req.session.user.id) return null;
    return conv;
}

/**
 * Strip whatever PII the guard still finds.
 *
 * Returns `{ text, checked }`. `checked` is the honest answer to "did a scan
 * actually happen", and it is the whole reason this returns a pair instead of
 * a string: `detectPii` fails open in TWO shapes, and only one of them looks
 * like a failure.
 *
 *   null                                    the guard is not installed;
 *   { hasPii:false, entities:[], degraded } the guard IS installed and could
 *                                           not scan — unreachable, or its
 *                                           circuit is open.
 *
 * The second one is the trap. It is shaped exactly like a clean answer, and
 * detect.js says so in as many words: "this is NOT the same as 'no PII'".
 * Reading it as clean is how a screen ends up promising a check that never
 * ran, so `degraded` is `checked: false` here, same as no guard at all.
 *
 * A tokeniser that throws on entities the guard DID find is the same story
 * from the other end: something was there and it is still there.
 *
 * The text is always returned — deciding what to do about an unchecked scan
 * belongs to the caller, and the two callers answer differently (the preview
 * says so, the write refuses).
 */
async function redact(text) {
    const raw = typeof text === 'string' ? text.trim() : '';
    if (!raw) return { text: '', checked: true };
    const clipped = raw.slice(0, MAX_EXAMPLE_CHARS);
    const { detectPii, tokenizeText, neutraliseTokens } = require('../../core/privacy/piiDetection');
    let detection = null;
    try {
        // `bulk` — behind chat, never in front of it. This is somebody
        // browsing their own history to build an example; the two-lane
        // admission control exists so that work cannot push a live turn out of
        // the way (requestShaping, MAX_INFLIGHT 2).
        detection = await detectPii(clipped, null, undefined, { priority: 'bulk' });
    } catch (_) {
        detection = null;
    }
    if (!detection || detection.degraded === true) return { text: clipped, checked: false };
    if (!Array.isArray(detection.entities) || detection.entities.length === 0) {
        // Nothing NEW found — but the text was read with `restore:false`, so
        // it may still carry the shield tokens of the conversation it came
        // from. Those have to go too; see below.
        return { text: neutraliseTokens(clipped), checked: true };
    }
    try {
        const { tokenizedText } = tokenizeText(clipped, detection.entities);
        if (typeof tokenizedText !== 'string') return { text: clipped, checked: false };
        // ── AND THEN THE TOKENS THEMSELVES ──────────────────────────
        // `tokenizeText` is called here with no seed map and no counter
        // floors, and it cannot sensibly be given either: this text is leaving
        // its conversation, so there is no map for it to extend. Its counters
        // therefore restart at 1 — and a stored `[person_1]` is not a
        // placeholder, it is a KEY in somebody else's token map. The example
        // goes verbatim into the system prompt of everyone who uses the skill
        // (skillStructure renders `question`/`good` into the text,
        // tools/skillInjection injects it), the model quotes it — that is what
        // examples are FOR — and the reader's own `restoreTokens` pass then
        // turns `[person_1]` into the reader's OWN customer, under a card that
        // says "personal data removed".
        //
        // So the last step is to drop the key as well as the value: every
        // token becomes a readable noun that nothing can restore.
        return { text: neutraliseTokens(tokenizedText), checked: true };
    } catch (_) {
        return { text: clipped, checked: false };
    }
}

/** The text a message contributes (string content or a content-block array). */
function textOfMessage(message) {
    const { messageText } = require('../../core/agentRuntime/phaseEvents');
    return messageText(message);
}

/**
 * The conversation's messages as `{ index, role, text }`, oldest first,
 * with tool traffic dropped: an example is a question and an answer, and a
 * tool_result block is neither. `index` is the position in the ORIGINAL
 * array, so the POST can address a message the preview filtered around.
 */
function readableMessages(conv) {
    const rows = Array.isArray(conv?.messages) ? conv.messages : [];
    const out = [];
    // Backwards, so the window is the LAST MESSAGE_LIMIT readable messages and
    // not the first. In a long chat the head-first version made the answer
    // somebody had just received unreachable — the exact case this feature
    // exists for ("the best examples come from an answer that already
    // happened"). Reversed once at the end so callers still see oldest first.
    for (let i = rows.length - 1; i >= 0 && out.length < MESSAGE_LIMIT; i -= 1) {
        const role = rows[i]?.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const text = textOfMessage(rows[i]);
        if (!text || !text.trim()) continue;
        out.push({ index: i, role, text: text.trim() });
    }
    out.reverse();
    return out;
}

/** The user message closest ABOVE `index` — the question that answer answers. */
function questionBefore(messages, index) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].index < index && messages[i].role === 'user') return messages[i].text;
    }
    return '';
}

/** A stable-enough id for a new example; the server keeps whatever it is given. */
function newExampleId() {
    return `ex_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ── GET /api/skills/examples/conversations ───────────────────────
// Owner-scoped by the store itself (`WHERE c.user_id = $1`) and narrowed
// again in the mapping: only what a picker needs leaves the server.
async function listConversations(req, res) {
    try {
        const agentStore = require('../../stores/agentStore');
        const rows = await agentStore.listAllConversations(req.session.user.id);
        res.json({
            conversations: (rows || []).map(r => ({
                id: r.id,
                title: r.title || null,
                agentId: r.agent_id || null,
                agentName: r.agent_name || null,
                updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
            })),
        });
    } catch (err) {
        log.error('[Skills] GET /examples/conversations error:', err);
        res.status(500).json({ error: 'Failed to load conversations' });
    }
}

// ── GET /api/skills/examples/conversations/:id/messages ──────────
async function listMessages(req, res) {
    try {
        const conv = await ownConversation(req, req.params.conversationId);
        // "Not yours" is indistinguishable from "not there": a 403 here
        // would confirm that an id exists in somebody else's account.
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        // What the picker actually OFFERS: assistant turns only (a question is
        // taken from the turn above the one that is picked, server-side), most
        // recent first, bounded. Every message beyond this list is a guard scan
        // paid for a row nobody can click.
        const messages = readableMessages(conv)
            .filter(m => m.role === 'assistant')
            .slice(-PREVIEW_LIMIT);
        const redacted = await Promise.all(messages.map(async (m) => {
            const { text, checked } = await redact(m.text);
            return { ...m, text, checked };
        }));
        // `piiChecked` is what the picker's promise is allowed to say. One
        // unchecked message is enough to withdraw it: the person is about to
        // choose from this list, and they cannot know which one it was.
        return res.json({
            messages: redacted.filter(m => m.text).map(({ checked, ...m }) => m),
            piiChecked: redacted.every(m => m.checked),
        });
    } catch (err) {
        log.error('[Skills] GET /examples/conversations/:id/messages error:', err);
        return res.status(500).json({ error: 'Failed to load conversation' });
    }
}

// ── POST /api/skills/:id/examples/from-message ───────────────────
// A write to a skill, so it carries the same gate every other skill write
// has: `manage_skills` on the route (applied by routes/skills.js) AND
// `canEdit` on the row itself.
async function fromMessage(req, res) {
    try {
        const skillStore = require('../../stores/skillStore');
        const { hasPermission } = require('../../auth/permissions');
        const orgId = await orgIdOf(req);
        let canManage = false;
        try { canManage = await hasPermission(req.session.user.id, 'manage_skills', req.session); } catch (_) { canManage = false; }
        const skill = await skillStore.getSkill(req.params.id, orgId, req.session.user.id, { canManage: canManage === true });
        if (!skill) return res.status(404).json({ error: 'Skill not found' });
        if (!skill.canEdit) return res.status(403).json({ error: 'You cannot edit this skill', code: 'not_editable' });

        const conv = await ownConversation(req, req.body?.conversationId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });

        const messages = readableMessages(conv);
        const index = Number(req.body?.messageIndex);
        const picked = messages.find(m => m.index === index);
        if (!picked) return res.status(400).json({ error: 'Message not found in that conversation', code: 'no_message' });

        // Before the scan, not after: a skill that is already full is refused
        // for a reason the person can act on, and no text is handed to the
        // guard for an example that was never going to be written.
        const existing = Array.isArray(skill.examplesV2) ? skill.examplesV2 : [];
        if (existing.length >= MAX_EXAMPLES) {
            return res.status(400).json({ error: 'This skill already has the maximum number of examples', code: 'too_many_examples' });
        }

        const good = await redact(picked.text);
        if (!good.text) return res.status(400).json({ error: 'That message has no text to use', code: 'empty_message' });
        const question = await redact(
            typeof req.body?.question === 'string' && req.body.question.trim()
                ? req.body.question
                : questionBefore(messages, picked.index),
        );

        // The screen promised that personal data would be removed, and here
        // that promise is either true or the answer is no. Storing the text
        // with a note attached is what the knowledge base does for documents
        // it cannot re-ask for — but an example is one click, repeatable the
        // moment the guard is back, and this text is copied OUT of the chat
        // it came from to be read later by people who were never in it. So
        // this path fails CLOSED. Typing the same sentence by hand is still
        // allowed: that is the person's own text, promised nothing.
        if (!good.checked || !question.checked) {
            return res.status(503).json({
                error: 'The personal-data check is unavailable, so this answer cannot be copied into an example right now.',
                code: 'pii_unchecked',
            });
        }

        const example = {
            id: newExampleId(),
            question: question.text,
            good: good.text,
            rationale: '',
            sourceConversationId: conv.id,
        };
        const examplesV2 = [...existing, example];

        const updated = await skillStore.updateSkill(
            skill.id,
            req.session.user.id,
            { examplesV2 },
            // Same widening the PUT route uses: only ever to the CALLER'S own
            // org, so a manager of another org is refused by the WHERE itself.
            { managerOrgId: skill.orgId && skill.orgId === orgId ? orgId : null },
        );
        if (!updated) return res.status(404).json({ error: 'Skill not found' });

        return res.status(201).json({ example, examplesV2 });
    } catch (err) {
        // Same answer PUT /:id gives. A structure refusal from the store is a
        // 400 with a `code` the client can act on; letting it fall through to
        // the bare 500 below left the person with "Failed to create the
        // example" and nothing to do about it.
        const { answerStructureError } = require('../skills');
        if (typeof answerStructureError === 'function' && answerStructureError(res, err)) return;
        log.error('[Skills] POST /:id/examples/from-message error:', err);
        return res.status(500).json({ error: 'Failed to create the example' });
    }
}

module.exports = {
    listConversations,
    listMessages,
    fromMessage,
    // Exported for the colocated test: reading and redacting are where this
    // feature can go wrong quietly, so they are testable on their own.
    ownConversation,
    redact,
    readableMessages,
    questionBefore,
    MAX_EXAMPLES,
    MAX_EXAMPLE_CHARS,
    MESSAGE_LIMIT,
    PREVIEW_LIMIT,
};
