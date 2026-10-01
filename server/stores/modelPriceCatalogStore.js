// @typecheck
/**
 * Model price catalogue store — table `model_price_catalog`.
 *
 * One row is the price card of (provider, model_id, tier) for the interval
 * [valid_from, valid_to). The table is APPEND-ONLY by contract: a changed rate is
 * a new row with a later valid_from, and an old row is never edited, so what a
 * call cost when it was made stays derivable (core/llm/modelCosts rates a call
 * with the row in force at the call's own timestamp, and usageStore stores that
 * rate on the usage row). The only edit the API allows is closing an open-ended
 * row (`closeRow`), for a promo that ends or a model that is withdrawn.
 *
 * The in-memory index that modelCosts reads lives in core/llm/priceCatalog.js
 * (pure, no database); this store loads it at boot (`initDB`), refreshes it after
 * every write, and registers itself as its refresher so a write on another
 * replica arrives within the index TTL.
 *
 * The importer (a later phase) is the only writer in production; everything it
 * hands in goes through the same validation the index applies, so a poisoned row
 * is refused at the door instead of being dropped at load time.
 *
 * Units: rates are `currency` per 1,000,000 tokens. Column type NUMERIC so the
 * stored rate is exact; the index converts to Number.
 */

'use strict';

const { run, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');
const priceCatalog = require('../core/llm/priceCatalog');
const log = require('../telemetry/log');

const initDB = makeStoreInit('ModelPriceCatalogStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS model_price_catalog (
            id BIGSERIAL PRIMARY KEY,
            provider TEXT NOT NULL,
            model_id TEXT NOT NULL,
            tier TEXT NOT NULL DEFAULT 'standard',
            currency TEXT NOT NULL DEFAULT 'USD',
            input NUMERIC(24,10) NOT NULL,
            output NUMERIC(24,10) NOT NULL,
            cache_read NUMERIC(24,10),
            cache_write_5m NUMERIC(24,10),
            cache_write_1h NUMERIC(24,10),
            long_ctx_threshold INTEGER,
            long_ctx_rates JSONB,
            multipliers JSONB,
            source TEXT NOT NULL,
            catalog_version TEXT NOT NULL,
            valid_from TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z',
            valid_to TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await runDdl('modelPriceCatalogStore', [
        // One card per (provider, model, tier, start): the append-only key.
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_model_price_catalog_card ON model_price_catalog(provider, model_id, tier, valid_from)`,
        `CREATE INDEX IF NOT EXISTS idx_model_price_catalog_model ON model_price_catalog(lower(model_id))`,
        // Defence in depth next to the importer's own validation (idempotent).
        { sql: `ALTER TABLE model_price_catalog ADD CONSTRAINT chk_model_price_catalog_rates CHECK (input >= 0 AND output >= 0 AND (valid_to IS NULL OR valid_to > valid_from))`,
          tolerate: ['42710', '42P07'], reden: 'constraint already exists on a re-run' },
    ]);
    priceCatalog.setRefresher(loadAll);
    await refreshIndex();
}

const COLUMNS = `id, provider, model_id, tier, currency, input, output, cache_read, cache_write_5m,
                 cache_write_1h, long_ctx_threshold, long_ctx_rates, multipliers, source,
                 catalog_version, valid_from, valid_to`;

/** Every row, oldest first. The catalogue is small (thousands), so it is read whole. */
async function loadAll() {
    await initDB();
    return getAll(`SELECT ${COLUMNS} FROM model_price_catalog ORDER BY valid_from ASC, id ASC`);
}

/** Re-read the table into the in-memory index. */
async function refreshIndex() {
    const rows = await getAll(`SELECT ${COLUMNS} FROM model_price_catalog ORDER BY valid_from ASC, id ASC`);
    return priceCatalog.setRows(rows);
}

/**
 * Append one price card. A card for the same (provider, model, tier, valid_from)
 * that already exists is left untouched (append-only), and `inserted` is false.
 *
 * @param {object} card  see core/llm/priceCatalog.validateRow for the fields
 * @returns {Promise<{ inserted: boolean, id: number|null }>}
 */
async function addPrice(card) {
    await initDB();
    const v = priceCatalog.validateRow(card);
    if (!v.row) throw new TypeError(`model_price_catalog: ${v.error}`);
    const r = v.row;
    const res = await run(`
        INSERT INTO model_price_catalog
            (provider, model_id, tier, currency, input, output, cache_read, cache_write_5m, cache_write_1h,
             long_ctx_threshold, long_ctx_rates, multipliers, source, catalog_version, valid_from, valid_to)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16)
        ON CONFLICT (provider, model_id, tier, valid_from) DO NOTHING
        RETURNING id
    `, [
        r.provider, r.model_id, r.tier, r.currency, r.input, r.output, r.cache_read, r.cache_write_5m, r.cache_write_1h,
        r.long_ctx_threshold,
        r.long_ctx_rates ? JSON.stringify(r.long_ctx_rates) : null,
        r.multipliers ? JSON.stringify(r.multipliers) : null,
        r.source, r.catalog_version, r.valid_from, r.valid_to,
    ]);
    const id = res && res.rows && res.rows[0] ? Number(res.rows[0].id) : null;
    if (id !== null) await refreshIndex().catch((e) => log.warn(`[ModelPriceCatalogStore] index refresh failed: ${e.message}`));
    return { inserted: id !== null, id };
}

/**
 * End an open-ended row at `validTo` (a promo that ends, a withdrawn model).
 * Never moves a row that is already closed and never closes before its start,
 * so a past call's rate cannot change.
 */
async function closeRow(id, validTo) {
    await initDB();
    const to = priceCatalog.toMs(validTo);
    const res = await run(
        `UPDATE model_price_catalog SET valid_to = $2 WHERE id = $1 AND valid_to IS NULL AND valid_from < $2 RETURNING id`,
        [id, new Date(to).toISOString()]);
    const closed = !!(res && res.rows && res.rows[0]);
    if (closed) await refreshIndex().catch((e) => log.warn(`[ModelPriceCatalogStore] index refresh failed: ${e.message}`));
    return { closed };
}

/** Rows for one model (any provider/tier/time), newest start first, for admin views. */
async function listPrices({ provider = null, modelId = null, limit = 200 } = {}) {
    await initDB();
    const params = [];
    const where = [];
    if (provider) { params.push(priceCatalog.normalizeProvider(provider) || String(provider)); where.push(`provider = $${params.length}`); }
    if (modelId) { params.push(String(modelId).toLowerCase()); where.push(`lower(model_id) = $${params.length}`); }
    params.push(Math.max(1, Math.min(1000, Number(limit) || 200)));
    return getAll(
        `SELECT ${COLUMNS} FROM model_price_catalog ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY valid_from DESC, id DESC LIMIT $${params.length}`,
        params);
}

module.exports = {
    initDB,
    loadAll,
    refreshIndex,
    addPrice,
    closeRow,
    listPrices,
};
