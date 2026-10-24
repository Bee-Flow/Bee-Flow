// @typecheck
/**
 * De chatgeschiedenis van de bouw-AI, per pagina bewaard.
 *
 * PUT /:id/chat  ·  DELETE /:id/chat
 */

const webpageStore = require('../../stores/webpageStore');
const { requireAuth } = require('../../auth/permissions');
const { validate } = require('../../core/http/validate');
const { z } = require('../../utils/zod');
const { bodyOf, NO_QUERY, NOTHING } = require('./schemas');

// ── What a chat save may carry ──────────────────────────────────────
//
// `messages` is REQUIRED, and that is not a question of form here. It stood there as
// `Array.isArray(req.body?.messages) ? req.body.messages : []`, and that `: []` is a
// WIPE: `PUT /:id/chat` with a misspelled key — `{"mesages": [...]}` — saved an empty
// list over the whole conversation history of the build AI and answered
// `{success:true,count:0}`. Clearing belongs to DELETE /:id/chat; a PUT that has
// nothing to say must be told so.
//
// What is inside a message belongs to the chat arm, not to this route: that shape
// changes with every tool the builder gets, and a second copy here would drift apart
// from it by itself.
const MESSAGES_TEXT = 'Stuur de berichten mee — { messages: [...] }';
const ChatBody = bodyOf({
    messages: z.array(z.unknown(), { error: MESSAGES_TEXT }),
});

function register(router) {
    // ── Chat history (per-webpage persistence) ───────────────────────────
    // Decoupled from the file-update PUT so frequent chat saves don't trigger
    // the file-PUT's sha256 + auto-versioning logic.
    router.put('/:id/chat', requireAuth, validate({ body: ChatBody, query: NO_QUERY }), async (req, res) => {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        const { messages } = req.body;
        await webpageStore.setChatMessages(req.params.id, userId, messages);
        res.json({ success: true, count: messages.length });
    });

    router.delete('/:id/chat', requireAuth, validate({ body: NOTHING, query: NO_QUERY }), async (req, res) => {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        await webpageStore.setChatMessages(req.params.id, userId, []);
        res.json({ success: true });
    });
}

module.exports = { register };
