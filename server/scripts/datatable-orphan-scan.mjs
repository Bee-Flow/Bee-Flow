#!/usr/bin/env node
/**
 * List every datatable schema in this database that no `datatable_models` row
 * describes — storage with no owner, no access filter, no retention sweep and
 * no UI able to reach it.
 *
 * Three ways to get one, all of them real:
 *   * a create that committed the `datatables` row and then failed its DDL
 *     (the pre-2026-09 shape: metadata first, CREATE TABLE second);
 *   * an organisation deleted before the teardown code existed;
 *   * a half-failed `dtorg_` → `dt_` rename, or a write that landed under the
 *     legacy name after one — where BOTH names exist for one tenant.
 *
 * READ ONLY. It prints; it never drops. Deleting a tenant's rows is a decision
 * with an Art. 17 record attached, not something a scan should take.
 *
 *   cd server && node scripts/datatable-orphan-scan.mjs
 *   docker exec beeflow-server node scripts/datatable-orphan-scan.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

require('dotenv').config({ path: path.resolve(here, '../../.env') });

const { getAll, getOne, pool } = require(path.resolve(here, '../db'));
const { schemaNameFor, LEGACY_ORG_PREFIX } = require(path.resolve(here, '../stores/datatableDbStore'));

async function main() {
    const probe = await getOne(`SELECT to_regclass('datatable_models') AS t`).catch(() => null);
    if (!probe?.t) {
        console.log('No datatable_models table in this database — nothing to scan.');
        return;
    }

    // By SCOPE, not by organisation: a PERSONAL tenancy has no organization_id,
    // so listing that column would hash `null`, miss every personal schema and
    // report the lot as orphaned — turning a scan whose whole job is "nobody
    // owns this storage" into a generator of false alarms.
    const models = await getAll(`SELECT scope_kind, scope_id FROM datatable_models`);
    // schema name → the tenant it belongs to. Both names per ORG tenant: the
    // hashed one is where a renamed tenant lives, the legacy one is where it
    // lived before, and a tenant this scan should NOT flag may still be on
    // either. A personal tenancy never had a legacy name.
    const owned = new Map();
    for (const { scope_kind: kind, scope_id: id } of models) {
        const label = `${kind}:${id}`;
        owned.set(schemaNameFor(kind, id), label);
        if (kind === 'org') owned.set(LEGACY_ORG_PREFIX + id, label);
    }

    const schemas = await getAll(
        `SELECT n.nspname AS name,
                COALESCE(SUM(pg_total_relation_size(c.oid)), 0)::bigint AS bytes,
                COUNT(c.oid)::int AS tables
           FROM pg_namespace n
           LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind = 'r'
          WHERE n.nspname LIKE 'dt\\_%' OR n.nspname LIKE 'dtorg\\_%'
          GROUP BY n.nspname
          ORDER BY n.nspname`,
    );

    const orphans = schemas.filter(s => !owned.has(s.name));
    // A tenant with BOTH names present is not an orphan by the test above — the
    // metadata row claims both — but exactly one of them is dead weight, and
    // only a person can say which. Report it separately.
    const doubled = [];
    const names = new Set(schemas.map(s => s.name));
    for (const { scope_kind: kind, scope_id: id } of models) {
        if (kind !== 'org') continue;   // only an org ever had a `dtorg_` name
        const hashed = schemaNameFor('org', id);
        const legacy = LEGACY_ORG_PREFIX + id;
        if (names.has(hashed) && names.has(legacy)) doubled.push({ orgId: id, hashed, legacy });
    }

    console.log(`Scanned ${schemas.length} datatable schema(s) against ${models.length} tenant(s).`);
    console.log('');
    if (!orphans.length) {
        console.log('  No orphaned schemas.');
    } else {
        console.log(`  ${orphans.length} ORPHANED schema(s) — no datatable_models row describes these:`);
        for (const o of orphans) {
            console.log(`    ${o.name}  ${o.tables} table(s), ${Number(o.bytes).toLocaleString()} bytes`);
        }
    }
    if (doubled.length) {
        console.log('');
        console.log(`  ${doubled.length} organisation(s) with BOTH a legacy and a hashed schema (half-failed rename):`);
        for (const d of doubled) console.log(`    ${d.orgId}: ${d.legacy} + ${d.hashed}`);
    }
    console.log('');
}

main()
    .catch((e) => { console.error('[orphan-scan] failed:', e.message); process.exitCode = 1; })
    .finally(() => pool.end().catch(() => {}));
