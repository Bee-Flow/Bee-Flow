/**
 * De paginadatabank achter de sessie: de DB-viewer (Schema / Browse / SQL) en
 * de reset. Spiegelt het AI-tooloppervlak in webpageDbTools.js, maar met de
 * sessie als grens in plaats van het model.
 *
 * DELETE /:id/db  ·  GET /:id/db/schema  ·  POST /:id/db/query  ·  POST /:id/db/exec
 */

const webpageStore = require('../../stores/webpageStore');
const webpageDbStore = require('../../stores/webpageDbStore');
const { requireAuth } = require('../../auth/permissions');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const { worded, bodyOf, NOTHING, NO_QUERY } = require('./schemas');
const log = require('../../telemetry/log');

// ── Wat de DB-viewer mag sturen ─────────────────────────────────────
//
// Dit IS de plek waar SQL binnenkomt — de SQL-tab van de viewer — en het is
// het enige oppervlak in deze router waar dat mag. De grens is de sessie: de
// tokenroutes van de preview schrijven rijen, deze route draait wat de
// eigenaar intypt, en webpageDbStore weigert zelf een mutatie op `query`.
//
// `params` moest een lijst zijn en werd anders stilletjes `[]`: een
// benoemd-parameterobject — `{":id": 3}` — liet de statement dan draaien
// ZONDER bindingen, en `?`-plekken zonder waarde geven een andere rij terug
// dan waar iemand om vroeg. Nu is het een lijst of een 400.
const SQL_TEXT = 'sql is required';
const PARAMS_TEXT = 'params is een lijst met waarden.';
const DbBody = bodyOf({
    sql: worded(SQL_TEXT).trim().min(1, SQL_TEXT),
    params: z.array(z.unknown(), { invalid_type_error: PARAMS_TEXT }).optional(),
});

function register(router) {
    // ── DB reset (privileged: session-auth) ─────────────────────────────
    //
    // Drops the entire SQLite database for this webpage. The token-authenticated
    // preview endpoints can write rows but can't reset the whole DB — that's a
    // destructive admin action that lives behind the session.
    router.delete('/:id/db', requireAuth, validate({ body: NOTHING, query: NO_QUERY }), async (req, res) => {
        try {
            const userId = req.session.user.id;
            const wp = await webpageStore.getWebpage(req.params.id, userId);
            if (!wp) return res.status(404).json({ error: 'Webpage not found' });
            await webpageDbStore.reset(userId, wp.id);
            res.json({ success: true });
        } catch (err) {
            log.error('[Webpages] DB reset failed:', err);
            res.status(500).json({ error: 'Failed to reset database' });
        }
    });

    // ── DB viewer endpoints (session-auth) ──────────────────────────────
    //
    // Power the in-app DB viewer (Schema / Browse / SQL tabs). Each one mirrors
    // the AI tool surface in webpageDbTools.js but lives behind the session
    // instead of the LLM, so the auth boundary is the same as DB reset above.

    router.get('/:id/db/schema', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
        try {
            const userId = req.session.user.id;
            const wp = await webpageStore.getWebpage(req.params.id, userId);
            if (!wp) return res.status(404).json({ error: 'Webpage not found' });
            const result = await webpageDbStore.schema(userId, wp.id);
            res.json(result);
        } catch (err) {
            log.error('[Webpages] DB schema failed:', err);
            res.status(500).json({ error: `Schema lookup failed: ${err.message}` });
        }
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
