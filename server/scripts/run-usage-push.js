'use strict';

/**
 * Standalone runner for the OpenObserve usage-push job — lets you test the push
 * locally without booting the whole server.
 *
 *   node server/scripts/run-usage-push.js           # push closed buckets once
 *   node server/scripts/run-usage-push.js --reset    # reset the watermark first (re-push backfill)
 *   node server/scripts/run-usage-push.js --twice    # run twice (idempotency check)
 *
 * Reads the same USAGE_PUSH_* / OTEL_EXPORTER_OTLP_* env as the server. For a
 * local test against the LIVE OpenObserve, point USAGE_PUSH_STREAM at a test
 * stream (e.g. ai_usage_test).
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { pool } = require('../db');
const configStore = require('../stores/configStore');
const push = require('../jobs/usageOpenObservePush');

const WATERMARK_KEY = 'usage_openobserve_watermark';

(async () => {
    try {
        if (!process.env.USAGE_PUSH_ENABLED) process.env.USAGE_PUSH_ENABLED = 'true'; // convenience for the runner
        if (process.argv.includes('--reset')) {
            await configStore.setConfig(WATERMARK_KEY, null);
            console.log('[run-usage-push] watermark reset (will re-push backfill window)');
        }
        console.log(`[run-usage-push] endpoint=${process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '(unset)'} `
            + `stream=${process.env.USAGE_PUSH_STREAM || 'ai_usage'}`);
        await push.processUsagePush();
        if (process.argv.includes('--twice')) {
            console.log('[run-usage-push] second run (should push 0 new — idempotency):');
            await push.processUsagePush();
        }
        console.log('[run-usage-push] done');
    } catch (e) {
        console.error('[run-usage-push] failed:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end().catch(() => {});
    }
})();
