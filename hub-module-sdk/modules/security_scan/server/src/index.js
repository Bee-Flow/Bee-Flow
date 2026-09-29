/**
 * Security Scan module — server entry.
 *
 * esbuild bundles this (+ its local imports and npm deps: dockerode, tar-stream)
 * into a single `server/entry.cjs`; only node: builtins stay external. The
 * loader (server/modules/packageLoader.js) requires the bundle and calls
 * `createModule(host)` with the frozen hostApiVersion:2 surface.
 *
 * D1 — DUAL RETURN SHAPE: the loader consumes a FLAT instance
 * (`instance.router`, `instance.initDBs()`, `instance.tick`, `instance.tickIntervalMs`);
 * it does NOT read `{ stores, workers }`. So createModule returns BOTH: the flat
 * fields the loader uses AND `stores`/`workers` arrays for the SDK/tests. Only
 * ONE tick actually runs under the loader, so it collapses drain + reap: it
 * drains EVERY call and reaps every ~8th call (15 s × 8 ≈ the 120 s reap cadence).
 */

'use strict';

const { makeSecurityScanStore } = require('./store');
const scanRunnerSvc = require('./scanRunner.service');
const reportBuilderMod = require('./reportBuilder');
const { makeDriver } = require('./driver');
const { makeWorker } = require('./worker');
const { mountSecurityRoutes } = require('./routes');

const MODULE_ID = 'security_scan';

// Collapse drain + reap into one loader tick: drain every tick, reap every 8th.
const REAP_EVERY_N_TICKS = 8;
const TICK_INTERVAL_MS = 15000;
const REAP_INTERVAL_MS = 120000;

/**
 * @param {import('../../test/hostMock.js').Host} host
 */
function createModule(host) {
    // Wire the pieces via small factories, each receiving only the host
    // primitives it needs.
    const store = makeSecurityScanStore({ db: host.db });
    const reportBuilder = reportBuilderMod.create(host);
    const driver = makeDriver({ store, reportBuilder, host });
    const worker = makeWorker({ store, scanRunner: scanRunnerSvc, driver, host });

    const router = host.express.Router();
    mountSecurityRoutes(router, { store, scanRunnerSvc, worker, host });

    const initDB = () => store.initDB();

    // ── The single loader tick (drain every call, reap every 8th) ──────────
    let _tickCount = 0;
    async function tick() {
        _tickCount += 1;
        try {
            await worker.drainOnce();
        } catch (e) {
            host.log.error(`[${MODULE_ID}] drain tick failed: ${e.message}`);
        }
        if (_tickCount % REAP_EVERY_N_TICKS === 0) {
            try {
                await worker.reapRunners();
            } catch (e) {
                host.log.error(`[${MODULE_ID}] reap tick failed: ${e.message}`);
            }
        }
    }

    return {
        // ── Flat fields the loader consumes (D1) ──────────────────────────
        router,
        initDBs: async () => { await initDB(); },
        tick,
        tickIntervalMs: TICK_INTERVAL_MS,

        // ── SDK / test-facing descriptors (loader ignores these) ──────────
        stores: [
            { name: 'securityScanStore', initDB },
        ],
        workers: [
            { id: 'security-scan-drain', intervalMs: TICK_INTERVAL_MS, tick: () => worker.drainOnce() },
            { id: 'security-scan-reap', intervalMs: REAP_INTERVAL_MS, tick: () => worker.reapRunners() },
        ],

        dispose() {
            host.log.info(`[${MODULE_ID}] disposed`);
        },
    };
}

module.exports = { createModule };
