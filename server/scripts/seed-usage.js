'use strict';

/**
 * Seed synthetic ai_usage_log data (+ matching organizations/users) into the
 * LOCAL dev DB so the OpenObserve usage/cost dashboard has rich content to
 * render without needing real chat traffic.
 *
 *   node server/scripts/seed-usage.js             # last 4h across 3 orgs x 5 users
 *   node server/scripts/seed-usage.js --hours 5   # custom recent window (keep <= OO ingest window)
 *
 * SAFETY: refuses to run unless the DB host is local (localhost/127.0.0.1),
 * unless SEED_ALLOW_REMOTE=1 is explicitly set. Never run this against prod.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { run, getOne, pool } = require('../db');
const usageStore = require('../stores/usageStore');
const userStore = require('../stores/userStore');

// ── local-DB guard ───────────────────────────────────────────────────────────
const CONN = process.env.CORE_DATABASE_URL || 'postgresql://beeflow:beeflow@localhost:5432/beeflow_core';
const HOST = (() => { try { return new URL(CONN).hostname; } catch { return ''; } })();
if (!['localhost', '127.0.0.1', '::1', ''].includes(HOST) && process.env.SEED_ALLOW_REMOTE !== '1') {
    console.error(`[seed-usage] Refusing to seed non-local DB host "${HOST}". Set SEED_ALLOW_REMOTE=1 to override.`);
    process.exit(1);
}

// Seed within a RECENT window by default. OpenObserve's ZO_INGEST_ALLOWED_UPTO
// (default 5h) rejects older data, so keeping the seed inside the last few hours
// lets the local push loop reach the live OpenObserve without raising that limit.
// For a longer history you must raise ZO_INGEST_ALLOWED_UPTO on the OO instance.
const argHours = (() => {
    const i = process.argv.indexOf('--hours');
    return i >= 0 ? Math.max(1, parseInt(process.argv[i + 1], 10) || 4) : 4;
})();

const ORGS = [
    { id: 'seed-org-acme', name: 'ACME Corp' },
    { id: 'seed-org-globex', name: 'Globex' },
    { id: 'seed-org-initech', name: 'Initech' },
];
const USERS = [
    { id: 'seed-user-alice', org: 'seed-org-acme', displayName: 'Alice Anderson', email: 'alice@acme.test' },
    { id: 'seed-user-bob', org: 'seed-org-acme', displayName: 'Bob Brown', email: 'bob@acme.test' },
    { id: 'seed-user-carol', org: 'seed-org-globex', displayName: 'Carol Clark', email: 'carol@globex.test' },
    { id: 'seed-user-dave', org: 'seed-org-globex', displayName: 'Dave Davis', email: 'dave@globex.test' },
    { id: 'seed-user-erin', org: 'seed-org-initech', displayName: 'Erin Evans', email: 'erin@initech.test' },
];
// [inputRate, outputRate] USD per 1M tokens (fabricated, offline — no pricing fetch)
const MODELS = {
    'claude-opus-4-8': [15, 75],
    'claude-haiku-4-5': [1, 5],
    'gpt-4o': [2.5, 10],
    'gemini-2.0-flash': [0.1, 0.4],
};
const SOURCES = ['chat', 'title', 'automation', 'swarm', 'task'];
const AGENT_TYPES = ['chat', 'automation', 'swarm'];
// PAYG orgs get a billed_cost (markup); others leave it NULL.
const PAYG_ORGS = new Set(['seed-org-globex']);
const MARKUP = 1.3;

const rnd = (a, b) => a + Math.random() * (b - a);
const rint = (a, b) => Math.floor(rnd(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function ensureOrgsAndUsers() {
    await userStore.getAllOrganizations(); // triggers userStore initDB (creates tables)
    for (const o of ORGS) {
        await run(
            `INSERT INTO organizations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
            [o.id, o.name]
        );
    }
    for (const u of USERS) {
        await run(
            `INSERT INTO users (id, username, "displayName", email, "organizationId")
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
            [u.id, u.id, u.displayName, u.email, u.org]
        );
    }
}

async function seedUsage() {
    await usageStore.getUsageModels(); // triggers usageStore initDB (creates ai_usage_log)
    const now = Date.now();
    const spanMs = argHours * 60 * 60 * 1000;
    let inserted = 0;

    for (const u of USERS) {
        // each user makes a bunch of calls scattered across the recent window
        const totalCalls = rint(15, 50);
        for (let n = 0; n < totalCalls; n++) {
            // keep everything at least 1 min in the past (within the ingest window)
            const ts = new Date(now - 60_000 - Math.random() * (spanMs - 60_000));
            const model = pick(Object.keys(MODELS));
            const [inRate, outRate] = MODELS[model];
            const prompt = rint(200, 6000);
            const completion = rint(50, 2500);
            const cached = Math.random() < 0.4 ? rint(0, prompt) : 0;
            const total = prompt + completion;
            const estUsd = (prompt / 1e6) * inRate + (completion / 1e6) * outRate;
            const estimated = Math.round(estUsd * 10000) / 10000;          // treat as EUR for the seed
            const billed = PAYG_ORGS.has(u.org) ? Math.round(estimated * MARKUP * 10000) / 10000 : null;
            const source = pick(SOURCES);
            const agentType = pick(AGENT_TYPES);
            const duration = rint(300, 9000);

            await run(
                `INSERT INTO ai_usage_log
                    (timestamp, user_id, organization_id, model, prompt_tokens, completion_tokens,
                     total_tokens, cached_tokens, estimated_cost, billed_cost, source, agent_type, duration_ms)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                [ts.toISOString(), u.id, u.org, model, prompt, completion, total, cached,
                    estimated, billed, source, agentType, duration]
            );
            inserted++;
        }
    }
    return inserted;
}

(async () => {
    try {
        console.log(`[seed-usage] host=${HOST || '(default local)'} window=${argHours}h`);
        await ensureOrgsAndUsers();
        const n = await seedUsage();
        const total = await getOne(`SELECT COUNT(*) AS c FROM ai_usage_log WHERE user_id LIKE 'seed-user-%'`);
        console.log(`[seed-usage] inserted ${n} rows (seed rows in table: ${total?.c}). Orgs: ${ORGS.map(o => o.name).join(', ')}`);
    } catch (e) {
        console.error('[seed-usage] failed:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end().catch(() => {});
    }
})();
