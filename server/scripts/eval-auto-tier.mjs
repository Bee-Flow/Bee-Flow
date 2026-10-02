#!/usr/bin/env node
/**
 * Evaluate the auto-tier classifier stages against a labelled corpus, so the
 * classify-service labels and cut-offs (core/llm/tierClassifierService.js)
 * are tuned on data rather than by feel.
 *
 *   CLASSIFY_SERVICE_URL=http://localhost:8300 node scripts/eval-auto-tier.mjs
 *   ... --corpus other.json   a different corpus ([{ tier, text }])
 *   ... --raw                 also print the verdict and the top two raw scores per item
 *
 * Prints, for the heuristic and for classify-service: accuracy per tier, a
 * confusion matrix, how often the service had no opinion (and so would fall
 * through to the LLM), and service latency p50/p95. The LLM stage needs a
 * configured provider and a database, so it is not part of this script.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// Quiet the per-call [Classifier] lines; this script prints its own report.
const log = require('../telemetry/log');
log.info = () => {};

const { classifyPromptComplexity } = require('../core/llm/promptClassifier');
const { classifyTierViaService, TIER_LABELS } = require('../core/llm/tierClassifierService');
const { classify } = require('../core/classify/classifierClient');

const args = process.argv.slice(2);
const corpusPath = args.includes('--corpus') ? resolve(args[args.indexOf('--corpus') + 1]) : resolve(here, 'eval-auto-tier.corpus.json');
const raw = args.includes('--raw');
const url = process.env.CLASSIFY_SERVICE_URL;
const apiKey = process.env.CLASSIFY_SERVICE_API_KEY || process.env.SERVICES_API_KEY || '';

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const TIER_ORDER = ['fast', 'thinking', 'writer', 'standard', 'deep_thinking'];
const tiers = Object.fromEntries(TIER_ORDER.map((t) => [t, { modelId: `eval-${t}` }]));

function report(name, rows) {
    const decided = rows.filter((r) => r.got);
    const correct = decided.filter((r) => r.got === r.want).length;
    console.log(`\n== ${name} ==`);
    console.log(`decided ${decided.length}/${rows.length}, correct ${correct}/${decided.length} (${decided.length ? ((100 * correct) / decided.length).toFixed(1) : '0.0'}%)`);
    const pad = (s, n = 14) => String(s).padEnd(n);
    console.log(pad('want \\ got') + [...TIER_ORDER, '(none)'].map((t) => pad(t)).join(''));
    for (const want of TIER_ORDER) {
        const row = rows.filter((r) => r.want === want);
        const cells = [...TIER_ORDER, null].map((got) => row.filter((r) => (r.got || null) === got).length);
        console.log(pad(want) + cells.map((c) => pad(c)).join(''));
    }
}

const pct = (xs, p) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const heuristicRows = corpus.map(({ tier, text }) => ({ want: tier, got: classifyPromptComplexity(text).tier }));
report('heuristic (verdict whether confident or not)', heuristicRows);

if (!url) {
    console.log('\nCLASSIFY_SERVICE_URL is not set: skipping classify-service.');
    process.exit(0);
}

const endpoint = { url: url.replace(/\/+$/, ''), apiKey };
const serviceRows = [];
const latencies = [];
for (const { tier, text } of corpus) {
    const heuristic = classifyPromptComplexity(text);
    const started = Date.now();
    // A generous deadline: this measures the service, not the chat cut-off.
    const out = await classifyTierViaService(text, tiers, { heuristic, endpoint, deadlineMs: 10_000 });
    latencies.push(Date.now() - started);
    serviceRows.push({ want: tier, got: out?.tier || null });
    if (raw) {
        // The raw scores behind the verdict (served from the client's score cache).
        const labels = Object.values(TIER_LABELS).sort();
        const { scores: [s] } = await classify([text.trim()], labels, { endpoint });
        const tierOf = (l) => Object.keys(TIER_LABELS).find((t) => TIER_LABELS[t] === l);
        const [a, b] = labels.map((l) => ({ t: tierOf(l), s: s[l] })).sort((x, y) => y.s - x.s);
        console.log(`${(out?.tier || '-').padEnd(14)} ${tier.padEnd(14)} ${a.t}=${a.s.toFixed(3)} ${b.t}=${b.s.toFixed(3)}  ${text.slice(0, 60)}`);
    }
}
report('classify-service', serviceRows);
console.log(`\nlatency p50 ${pct(latencies, 50)}ms, p95 ${pct(latencies, 95)}ms, max ${Math.max(...latencies)}ms`);
// The required server modules hold the database pool open.
process.exit(0);
