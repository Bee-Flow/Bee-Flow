/**
 * De chatgeschiedenis van de bouw-AI, per pagina bewaard.
 *
 * PUT /:id/chat  ·  DELETE /:id/chat
 */

const webpageStore = require('../../stores/webpageStore');
const { requireAuth } = require('../../auth/permissions');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const { bodyOf, NO_QUERY, NOTHING } = require('./schemas');
const log = require('../../telemetry/log');

// ── Wat een chat-save mag dragen ────────────────────────────────────
//
// `messages` is VERPLICHT, en dat is hier geen vormkwestie. Het stond er als
// `Array.isArray(req.body?.messages) ? req.body.messages : []`, en die `: []`
// is een WISSEN: `PUT /:id/chat` met een verkeerd gespelde sleutel —
// `{"mesages": [...]}` — sloeg een lege lijst op over de hele
// gespreksgeschiedenis van de bouw-AI en antwoordde `{success:true,count:0}`.
// Leegmaken hoort bij DELETE /:id/chat; een PUT die niets te zeggen heeft moet
// dat gezegd krijgen.
//
// Wat er ín een bericht staat is van de chat-arm, niet van deze route: die
// vorm verandert met elk gereedschap dat de bouwer krijgt, en een tweede
// kopie hier zou er vanzelf van gaan verschillen.
const MESSAGES_TEXT = 'Stuur de berichten mee — { messages: [...] }';
const ChatBody = bodyOf({
    messages: z.array(z.unknown(), { required_error: MESSAGES_TEXT, invalid_type_error: MESSAGES_TEXT }),
});

function register(router) {
    // ── Chat history (per-webpage persistence) ───────────────────────────
    // Decoupled from the file-update PUT so frequent chat saves don't trigger
    // the file-PUT's sha256 + auto-versioning logic.
    router.put('/:id/chat', requireAuth, validate({ body: ChatBody, query: NO_QUERY }), async (req, res) => {
        try {
            const userId = req.session.user.id;
            const wp = await webpageStore.getWebpage(req.params.id, userId);
            if (!wp) return res.status(404).json({ error: 'Webpage not found' });
            const { messages } = req.body;
            await webpageStore.setChatMessages(req.params.id, userId, messages);
            res.json({ success: true, count: messages.length });
        } catch (err) {
            log.error('[Webpages] Chat save failed:', err);
            res.status(500).json({ error: 'Failed to save chat history' });
        }
    });

    router.delete('/:id/chat', requireAuth, validate({ body: NOTHING, query: NO_QUERY }), async (req, res) => {
        try {
            const userId = req.session.user.id;
            const wp = await webpageStore.getWebpage(req.params.id, userId);
            if (!wp) return res.status(404).json({ error: 'Webpage not found' });
            await webpageStore.setChatMessages(req.params.id, userId, []);
            res.json({ success: true });
        } catch (err) {
            log.error('[Webpages] Chat clear failed:', err);
            res.status(500).json({ error: 'Failed to clear chat history' });
        }
    });
}

module.exports = { register };
