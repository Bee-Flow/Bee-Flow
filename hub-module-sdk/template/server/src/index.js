/**
 * Example module server entry.
 *
 * esbuild bundles this (with any npm deps you import) into a single
 * `server/entry.cjs`; only node: builtins stay external. The bundle must
 * export `createModule(host)` returning the FLAT loader contract:
 *   { router, initDBs?, tick?, tickIntervalMs?, dispose? }
 * (the host runs initDBs() once at activation, owns the tick interval, and
 * calls dispose() on deactivate/hot-swap).
 *
 * `host` is the frozen host API surface — see ../../test/hostMock.js for the
 * exact shape. With manifestVersion 2 you receive ONLY the surfaces your
 * manifest's `permissions` list grants (this template grants "db"); the core
 * set (express, middleware, log, dataDir, isModuleActive, net) is always
 * present. Do NOT `require()` product internals; everything the module needs
 * is injected via `host`.
 */

const MODULE_ID = 'example_module';

const TICK_INTERVAL_MS = 60000;

/**
 * @param {import('../../test/hostMock.js').Host} host
 * @returns {{ router: object, initDBs: Function, tick: Function, tickIntervalMs: number, dispose: Function }}
 */
export function createModule(host) {
    const { express, db, log } = host;

    // ── routes: mounted under the module dispatcher (/api/mod/<id>/…) ─────
    const router = express.Router();

    router.get('/ping', (req, res) => {
        res.json({ ok: true, module: MODULE_ID, ts: Date.now() });
    });

    router.get('/pings', async (req, res) => {
        try {
            const rows = await db.getAll(
                'SELECT id, note, created_at FROM example_pings ORDER BY id DESC LIMIT 50'
            );
            res.json({ pings: rows });
        } catch (e) {
            log.error(`[${MODULE_ID}] list pings failed: ${e.message}`);
            res.status(500).json({ error: 'internal_error' });
        }
    });

    router.post('/pings', express.json(), async (req, res) => {
        const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : '';
        await db.run(
            'INSERT INTO example_pings (note, created_at) VALUES ($1, $2)',
            [note, Date.now()]
        );
        res.status(201).json({ ok: true });
    });

    return {
        router,

        // Run once at activation, BEFORE any route is exposed — a throw aborts
        // the activation so routes never serve over a half-materialised schema.
        async initDBs() {
            await db.exec(`
                CREATE TABLE IF NOT EXISTS example_pings (
                    id BIGSERIAL PRIMARY KEY,
                    note TEXT NOT NULL DEFAULT '',
                    created_at BIGINT NOT NULL
                )
            `);
        },

        // Host-owned worker: the host self-gates the tick on module activity
        // and suppresses overlap, so the body can stay simple.
        tickIntervalMs: TICK_INTERVAL_MS,
        async tick() {
            await db.run(
                'INSERT INTO example_pings (note, created_at) VALUES ($1, $2)',
                ['heartbeat', Date.now()]
            );
            log.info(`[${MODULE_ID}] heartbeat recorded`);
        },

        // Called on deactivate and on hot-swap of a newer version — release
        // any OS resources (sockets, watchers, child processes) here.
        dispose() {
            log.info(`[${MODULE_ID}] disposed`);
        },
    };
}

export default { createModule };
