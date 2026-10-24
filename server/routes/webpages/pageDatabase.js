/**
 * The page database behind the session: the DB viewer (Schema / Browse / SQL) and the
 * reset. Mirrors the AI tool surface in webpageDbTools.js, but with the session as the
 * boundary instead of the model.
 *
 * DELETE /:id/db  ·  GET /:id/db/schema  ·  POST /:id/db/query  ·  POST /:id/db/exec
 */

const webpageStore = require('../../stores/webpageStore');
const webpageDbStore = require('../../stores/webpageDbStore');
const { requireAuth } = require('../../auth/permissions');
const { validate } = require('../../core/http/validate');
const { z, typeError } = require('../../utils/zod');
const { worded, bodyOf, NOTHING, NO_QUERY } = require('./schemas');

// ── What the DB viewer may send ─────────────────────────────────────
//
// This IS the place where SQL comes in — the SQL tab of the viewer — and it is the only
// surface in this router where that may happen. The boundary is the session: the token
// routes of the preview write rows, this route runs what the owner types in, and
// webpageDbStore refuses a mutation on `query` itself.
//
// `params` had to be a list and otherwise silently became `[]`: a named-parameter object
// — `{":id": 3}` — then let the statement run WITHOUT bindings, and `?` places without a
// value returned a different row than the one someone asked for. Now it is a list or a 400.
const SQL_TEXT = 'sql is required';
const PARAMS_TEXT = 'params is een lijst met waarden.';
const DbBody = bodyOf({
    sql: worded(SQL_TEXT).trim().min(1, SQL_TEXT),
    params: z.array(z.unknown(), { error: typeError({ invalid: PARAMS_TEXT }) }).optional(),
});

function register(router) {
    // ── DB reset (privileged: session-auth) ─────────────────────────────
    //
    // Drops the entire SQLite database for this webpage. The token-authenticated
    // preview endpoints can write rows but can't reset the whole DB — that's a
    // destructive admin action that lives behind the session.
    router.delete('/:id/db', requireAuth, validate({ body: NOTHING, query: NO_QUERY }), async (req, res) => {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        await webpageDbStore.reset(userId, wp.id);
        res.json({ success: true });
    });

    // ── DB viewer endpoints (session-auth) ──────────────────────────────
    //
    // Power the in-app DB viewer (Schema / Browse / SQL tabs). Each one mirrors
    // the AI tool surface in webpageDbTools.js but lives behind the session
    // instead of the LLM, so the auth boundary is the same as DB reset above.

    router.get('/:id/db/schema', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        const result = await webpageDbStore.schema(userId, wp.id);
        res.json(result);
    });

    router.post('/:id/db/query', requireAuth, validate({ body: DbBody, query: NO_QUERY }), async (req, res) => {
        try {
            const userId = req.session.user.id;
            const wp = await webpageStore.getWebpage(req.params.id, userId);
            if (!wp) return res.status(404).json({ error: 'Webpage not found' });
            const { sql, params } = req.body;
            const result = await webpageDbStore.query(userId, wp.id, sql, params || []);
            res.json(result);
        } catch (err) {
            // Mutation-attempt errors come back here too — surface the message verbatim
            // so the SQL tab can render "use exec instead" inline.
            res.status(400).json({ error: err.message });
        }
    });

    router.post('/:id/db/exec', requireAuth, validate({ body: DbBody, query: NO_QUERY }), async (req, res) => {
        try {
            const userId = req.session.user.id;
            const wp = await webpageStore.getWebpage(req.params.id, userId);
            if (!wp) return res.status(404).json({ error: 'Webpage not found' });
            const { sql, params } = req.body;
            const result = await webpageDbStore.exec(userId, wp.id, sql, params || []);
            res.json(result);
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });
}

module.exports = { register };
