#!/usr/bin/env node
/**
 * vuln-watch gate — turns the OSV-Scanner report and the runtime-watch report
 * into one verdict, one SARIF file for the Security tab and one summary.
 *
 * WHAT TURNS THE RUN RED: a HIGH or CRITICAL (CVSS >= 7.0, or GitHub's label
 * when there is no score) in something that ships, that is not accepted; a
 * runtime with a newer security release or past its EOL; an accepted entry
 * that expired; and any input that could not be read. A scanner that could not
 * scan is never reported as clean.
 *
 * WHAT IS REPORTED BUT DOES NOT TURN IT RED: the same severities in tooling —
 * a lockfile whose directory has role `tooling` in scripts/packages.json, a
 * `requirements-{dev,test,eval,docs}` file, or an npm package that the
 * lockfile marks `dev` everywhere it occurs. They still go to the Security
 * tab, as warnings. Both rules come from files that already exist for other
 * reasons, so a new package is classified the day it is registered.
 *
 * ACCEPTING: an advisory that cannot be fixed yet goes in
 * .github/security/vuln-watch-accepted.json as { id, reason, expires } with
 * optional `package` and `path` (a path prefix) to narrow it. The `accepted`
 * entries of .github/security/audit-baseline.json count too, so an advisory
 * reviewed for the npm audit ratchet is not reviewed twice.
 *
 *   node scripts/vuln-watch-gate.mjs --osv osv.json --runtime runtime.json \
 *       [--sarif out.sarif] [--summary out.md]
 *
 * Zero dependencies: node:* only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIGH = 7.0;
const CRITICAL = 9.0;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEV_REQUIREMENTS = /^requirements-(dev|test|eval|docs)[^/]*\.txt$/;
const LABEL_SCORE = { CRITICAL: 9.0, HIGH: 7.0, MODERATE: 5.0, MEDIUM: 5.0, LOW: 2.0 };

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Score of an OSV group: its CVSS, else the database label of any of its ids. */
export function scoreOf(group, vulns) {
    const n = Number.parseFloat(group.max_severity);
    if (Number.isFinite(n)) return n;
    const labels = vulns
        .filter((v) => group.ids.includes(v.id))
        .map((v) => LABEL_SCORE[String(v.database_specific?.severity || '').toUpperCase()] || 0);
    return Math.max(0, ...labels);
}

/** GHSA first: it is the id GitHub links and the audit ratchet records. */
export function primaryId(group) {
    return [...group.ids, ...(group.aliases || [])].find((i) => i.startsWith('GHSA-')) || group.ids[0];
}

export function roleOf(dir, registry) {
    let d = dir;
    for (;;) {
        const hit = registry.find((p) => p.dir === d);
        if (hit) return hit.role;
        if (d === '.' || d === '') return 'unregistered';
        d = path.posix.dirname(d);
    }
}

function lockIndex(root, file, cache) {
    if (!cache.has(file)) {
        let entries = [];
        try {
            const lock = readJson(path.join(root, file));
            entries = Object.entries(lock.packages || {}).filter(([k]) => k.includes('node_modules/'));
        } catch {
            // an unreadable lock: nothing is classified dev, so nothing is softened
        }
        cache.set(file, entries);
    }
    return cache.get(file);
}

/** Dev only when every copy of name@version in the lock is marked `dev`. */
export function isDevOnly(entries, name, version) {
    const copies = entries.filter(([k, v]) => k.endsWith(`node_modules/${name}`) && v.version === version);
    return copies.length > 0 && copies.every(([, v]) => v.dev === true);
}

function lineOf(root, file, name) {
    try {
        const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
        const needle = file.endsWith('package-lock.json') ? `"node_modules/${name}": {` : null;
        const re = needle ? null : new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[-_.]/g, '[-_.]')}\\s*(\\[|[=<>~!])`, 'i');
        const i = lines.findIndex((l) => (needle ? l.includes(needle) : re.test(l)));
        return i >= 0 ? i + 1 : 1;
    } catch {
        return 1;
    }
}

export function acceptedErrors(list, where) {
    if (!Array.isArray(list)) return [`${where}: \`accepted\` must be an array`];
    return list.flatMap((a, i) => {
        const at = `${where} accepted[${i}]`;
        const errs = [];
        if (typeof a?.id !== 'string' || !a.id) errs.push(`${at}: needs an \`id\``);
        if (typeof a?.reason !== 'string' || !a.reason.trim()) errs.push(`${at}: needs a \`reason\``);
        if (typeof a?.expires !== 'string' || !DATE.test(a.expires) || Number.isNaN(Date.parse(a.expires))) errs.push(`${at}: needs an \`expires\` date as YYYY-MM-DD`); // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- anchored fixed-width digit pattern, linear
        return errs;
    });
}

function acceptedFor(accepted, f) {
    return accepted.find((a) =>
        (a.id === f.id || (f.aliases || []).includes(a.id)) &&
        (!a.package || a.package === f.package) &&
        (!a.path || f.file === a.path || f.file.startsWith(a.path.replace(/\/?$/, '/'))));
}

/** OSV report -> findings at or above HIGH, one per lockfile, package and advisory. */
export function osvFindings(report, { root = ROOT, registry = [] } = {}) {
    const out = [];
    const cache = new Map();
    for (const result of report.results || []) {
        const abs = result.source?.path || '';
        const file = path.relative(root, path.isAbsolute(abs) ? abs : path.join(root, abs)).split(path.sep).join('/');
        const dir = path.posix.dirname(file);
        const role = roleOf(dir, registry);
        for (const p of result.packages || []) {
            const { name, version, ecosystem } = p.package;
            for (const g of p.groups || []) {
                const score = scoreOf(g, p.vulnerabilities || []);
                if (score < HIGH) continue;
                let devReason = null;
                if (role === 'tooling') devReason = 'tooling';
                else if (DEV_REQUIREMENTS.test(path.posix.basename(file))) devReason = 'dev requirements';
                else if (file.endsWith('package-lock.json') && isDevOnly(lockIndex(root, file, cache), name, version)) devReason = 'dev dependency';
                const id = primaryId(g);
                const vuln = (p.vulnerabilities || []).find((v) => g.ids.includes(v.id));
                out.push({
                    kind: 'dependency', id, aliases: [...new Set([...g.ids, ...(g.aliases || [])])], score,
                    package: name, version, ecosystem, file, line: lineOf(root, file, name),
                    summary: vuln?.summary || '', gating: !devReason, devReason,
                });
            }
        }
    }
    return out;
}

export function runtimeFindings(report) {
    return (report.findings || []).map((f) => ({
        kind: 'runtime', id: f.id, aliases: [], score: f.level === 'high' ? 7.5 : 0, file: f.file, line: f.line,
        package: f.ref, level: f.level, summary: f.message, gating: f.level === 'high' || f.level === 'error',
    }));
}

export function evaluate(findings, accepted, today) {
    const fail = [];
    const acceptedHits = [];
    const report = [];
    for (const f of findings) {
        if (f.kind === 'runtime' && f.level === 'error') {
            fail.push({ f, why: 'could not be checked' });
            continue;
        }
        if (!f.gating) {
            if (f.kind === 'dependency') report.push(f);
            continue;
        }
        const a = acceptedFor(accepted, f);
        if (a && a.expires >= today) acceptedHits.push({ f, a });
        else if (a) fail.push({ f, why: `accepted until ${a.expires}, expired` });
        else fail.push({ f, why: 'new' });
    }
    return { fail, acceptedHits, report };
}

export function toSarif(findings, version = '1') {
    const relevant = findings.filter((f) => f.score >= HIGH);
    const rules = new Map();
    for (const f of relevant) {
        if (rules.has(f.id)) continue;
        rules.set(f.id, {
            id: f.id,
            shortDescription: { text: f.kind === 'runtime' ? 'Runtime behind a security release or past end of life' : (f.summary || f.id) },
            helpUri: f.id.startsWith('GHSA-') ? `https://github.com/advisories/${f.id}` : f.kind === 'dependency' ? `https://osv.dev/vulnerability/${f.id}` : undefined,
            properties: { 'security-severity': f.score.toFixed(1), tags: ['security', f.kind] },
        });
    }
    return {
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        version: '2.1.0',
        runs: [{
            tool: { driver: { name: 'vuln-watch', version, informationUri: 'https://osv.dev', rules: [...rules.values()] } },
            results: relevant.map((f) => ({
                ruleId: f.id,
                level: f.gating ? 'error' : 'warning',
                message: {
                    text: f.kind === 'runtime'
                        ? f.summary
                        : `${f.package} ${f.version} (${f.ecosystem}) is affected by ${f.id}, CVSS ${f.score.toFixed(1)}${f.devReason ? ` — ${f.devReason}, does not ship` : ''}. ${f.summary}`.trim(),
                },
                locations: [{ physicalLocation: { artifactLocation: { uri: f.file }, region: { startLine: f.line } } }],
                partialFingerprints: { vulnWatch: `${f.id}|${f.file}|${f.package}` },
            })),
        }],
    };
}

function label(f) {
    if (f.kind === 'runtime') return `${f.file}:${f.line} — ${f.summary}`;
    const sev = f.score >= CRITICAL ? 'CRITICAL' : 'HIGH';
    return `${sev} ${f.score.toFixed(1)} ${f.id} — ${f.package}@${f.version} in ${f.file}`;
}

export function summarize({ fail, acceptedHits, report }, runtime, errors) {
    const lines = ['### Vulnerability watch', ''];
    for (const e of errors) lines.push(`- ❌ ${e}`);
    if (fail.length) {
        lines.push(`**${fail.length} finding(s) need action** (fix, or accept with a reason and an expiry in \`.github/security/vuln-watch-accepted.json\`):`, '');
        for (const { f, why } of fail) lines.push(`- ❌ ${label(f)} (${why})`);
    } else if (!errors.length) {
        lines.push('✅ No new HIGH or CRITICAL finding in anything that ships, and every runtime is on its latest security release.');
    }
    if (acceptedHits.length) {
        lines.push('', `<details><summary>${acceptedHits.length} accepted</summary>`, '');
        for (const { f, a } of acceptedHits) lines.push(`- ➖ ${label(f)} — until ${a.expires}`);
        lines.push('', '</details>');
    }
    if (report.length) {
        lines.push('', `<details><summary>${report.length} HIGH/CRITICAL in tooling or dev dependencies (Security tab, not gating)</summary>`, '');
        for (const f of report.slice(0, 200)) lines.push(`- ${label(f)} (${f.devReason})`);
        lines.push('', '</details>');
    }
    const notices = (runtime.findings || []).filter((f) => f.level === 'notice' || f.level === 'unchecked');
    if (notices.length) {
        lines.push('', `<details><summary>${notices.length} runtime notice(s)</summary>`, '');
        for (const f of notices) lines.push(`- ${f.level}: ${f.file}:${f.line} — ${f.message}`);
        lines.push('', '</details>');
    }
    return lines.join('\n');
}

export function main(argv = process.argv.slice(2), { root = ROOT, today = new Date().toISOString().slice(0, 10), log = console.log } = {}) {
    const arg = (name) => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const errors = [];
    const load = (file, what) => {
        try {
            return readJson(file);
        } catch (e) {
            errors.push(`${what} could not be read (${file}): ${e.message}`);
            return null;
        }
    };
    const osv = load(arg('--osv'), 'the OSV-Scanner report');
    const runtime = load(arg('--runtime'), 'the runtime-watch report') || { findings: [] };
    if (osv && !Array.isArray(osv.results)) errors.push('the OSV-Scanner report has no `results` array');
    if (osv && Array.isArray(osv.results) && osv.results.length === 0) errors.push('the OSV-Scanner report lists no lockfile at all: the scan saw nothing');

    const registry = load(path.join(root, 'scripts/packages.json'), 'scripts/packages.json')?.packages || [];
    const own = fs.existsSync(path.join(root, '.github/security/vuln-watch-accepted.json'))
        ? load(path.join(root, '.github/security/vuln-watch-accepted.json'), 'vuln-watch-accepted.json')?.accepted ?? []
        : [];
    const audit = fs.existsSync(path.join(root, '.github/security/audit-baseline.json'))
        ? load(path.join(root, '.github/security/audit-baseline.json'), 'audit-baseline.json')?.accepted ?? []
        : [];
    const listErrors = [...acceptedErrors(own, 'vuln-watch-accepted.json'), ...acceptedErrors(audit, 'audit-baseline.json')];
    errors.push(...listErrors);

    const findings = [...(osv?.results ? osvFindings(osv, { root, registry }) : []), ...runtimeFindings(runtime)];
    const verdict = evaluate(findings, listErrors.length ? [] : [...own, ...audit], today);
    const summary = summarize(verdict, runtime, errors);

    if (arg('--sarif')) fs.writeFileSync(arg('--sarif'), JSON.stringify(toSarif(findings), null, 2));
    if (arg('--summary')) fs.writeFileSync(arg('--summary'), summary + '\n');
    log(summary);
    return errors.length || verdict.fail.length ? 1 : 0;
}

if (isEntryPoint(import.meta.url)) process.exitCode = main();
