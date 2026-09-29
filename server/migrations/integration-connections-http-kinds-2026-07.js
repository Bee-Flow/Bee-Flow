/**
 * Migration: widen integration_connections.kind for HTTP credentials.
 *
 * Feature C (secure reusable credentials for the http_request automation step)
 * stores all HTTP credentials under provider 'http' and reuses the existing
 * kinds api_key (custom-header key) and basic, plus two NEW kinds:
 *
 *   bearer     — a static bearer token  → Authorization: Bearer <token>
 *   oauth2_cc  — OAuth2 client-credentials → token fetched at run time
 *
 * Only the CHECK constraint changes; no data backfill needed. Idempotent:
 * DROP IF EXISTS + re-ADD converges on the widened list on every run.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE integration_connections DROP CONSTRAINT IF EXISTS integration_connections_kind_check`);
    await exec(`
        ALTER TABLE integration_connections ADD CONSTRAINT integration_connections_kind_check
            CHECK (kind IN ('oauth','api_key','basic','mcp','bearer','oauth2_cc'))
    `);
    console.log('[Migration] integration-connections-http-kinds-2026-07 applied');
}

module.exports = { up };
