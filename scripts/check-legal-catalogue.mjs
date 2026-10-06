#!/usr/bin/env node
/**
 * The legal register the Compliance Center scores against must say where its
 * facts come from and when they were last checked.
 *
 * server/compliance/frameworks.js carries, per framework, the official texts
 * it was checked against (`sources`) and the day of that check
 * (`legal_status_verified`). This guard holds two kinds of line:
 *
 *   ERRORS (exit 1) — the register is malformed, so nobody could tell whether
 *   it is current: a framework without sources, a source that is not an https
 *   link, a verification date that is missing, unreadable or in the future,
 *   an undated milestone that is not marked 'uncertain' with an expected
 *   quarter.
 *
 *   WARNINGS (exit 0) — the register is well-formed but due for review: a
 *   framework checked more than LEGAL_REVIEW_STALE_DAYS (90) days ago, or an
 *   'uncertain' milestone whose expected quarter has passed. These do not
 *   fail CI on their own: an unrelated pull request should not turn red
 *   because the calendar moved. They are printed as GitHub annotations, the
 *   product reports the same age (check ISO27001-A.5.31-legal-register), and
 *   the monthly review routine acts on them.
 *
 * Run: npm run lint:legal-catalogue   (joins `npm run check:fast` by itself)
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const QUARTER = /^(\d{4})-Q([1-4])$/;

/** Last millisecond of a quarter like '2026-Q4' (UTC), or NaN. */
export function quarterEndMs(expected) {
    const m = QUARTER.exec(String(expected || ''));
    if (!m) return NaN;
    const year = Number(m[1]);
    const q = Number(m[2]);
    return Date.UTC(year, q * 3, 1) - 1;
}

/**
 * Judge a catalogue. Pure: the caller passes the frameworks, the milestones,
 * the stale threshold and "now", so the test can move the clock.
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function assessCatalogue({ frameworks, milestones = [], staleAfterDays = 90, nowMs = Date.now() }) {
    const errors = [];
    const warnings = [];
    for (const fw of frameworks || []) {
        const id = fw && fw.id ? fw.id : '(unnamed)';
        const sources = Array.isArray(fw?.sources) ? fw.sources : [];
        if (!sources.length) errors.push(`${id}: no sources — name the official text this entry was checked against.`);
        for (const src of sources) {
            if (!src || typeof src.url !== 'string' || !src.url.startsWith('https://')) {
                errors.push(`${id}: source ${JSON.stringify(src && src.url)} is not an https link.`);
            }
            if (!src || typeof src.label !== 'string' || !src.label.trim()) errors.push(`${id}: a source has no label.`);
        }
        const verified = fw?.legal_status_verified;
        const ms = typeof verified === 'string' && ISO_DAY.test(verified) ? Date.parse(`${verified}T00:00:00Z`) : NaN;
        if (!Number.isFinite(ms)) {
            errors.push(`${id}: legal_status_verified ${JSON.stringify(verified)} is not an ISO date (YYYY-MM-DD).`);
            continue;
        }
        if (ms > nowMs + DAY_MS) errors.push(`${id}: legal_status_verified ${verified} is in the future.`);
        const age = Math.floor((nowMs - ms) / DAY_MS);
        if (age > staleAfterDays) {
            warnings.push(`${id}: legal status last checked ${verified} (${age} days ago, limit ${staleAfterDays}) — re-read its sources, correct what changed and move the date.`);
        }
    }
    for (const m of milestones || []) {
        if (m && m.date) continue;
        const id = m && m.id ? m.id : '(unnamed milestone)';
        if (m?.kind !== 'uncertain' || !QUARTER.test(String(m?.expected || ''))) {
            errors.push(`${id}: a milestone without a date must be kind 'uncertain' with an expected quarter like '2026-Q4'.`);
            continue;
        }
        if (quarterEndMs(m.expected) < nowMs) {
            warnings.push(`${id}: expected ${m.expected}, which has passed — check whether it was decided and date it, or move the expectation.`);
        }
    }
    return { errors, warnings };
}

function main() {
    const require = createRequire(import.meta.url);
    const catalogue = require(path.join(ROOT, 'server/compliance/frameworks.js'));
    const { errors, warnings } = assessCatalogue({
        frameworks: catalogue.listBuiltin(),
        milestones: catalogue.MILESTONES,
        staleAfterDays: catalogue.LEGAL_REVIEW_STALE_DAYS,
    });
    const gha = process.env.GITHUB_ACTIONS === 'true';
    for (const w of warnings) console.log(gha ? `::warning file=server/compliance/frameworks.js::${w}` : `warning: ${w}`);
    for (const e of errors) console.error(gha ? `::error file=server/compliance/frameworks.js::${e}` : `error: ${e}`);
    if (errors.length) {
        console.error(`legal catalogue: ${errors.length} error(s).`);
        process.exit(1);
    }
    console.log(`legal catalogue: ok (${catalogue.listBuiltin().length} frameworks${warnings.length ? `, ${warnings.length} due for review` : ''}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
