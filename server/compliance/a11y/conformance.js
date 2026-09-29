/**
 * Reader for the CI accessibility-conformance artefact.
 *
 * The product's public surfaces (hosted forms, public Studio-app pages, the
 * DSR form, the shared-webpage viewer) render client-side, and the production
 * image ships no browser (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1). So the axe run
 * happens in CI (.github/workflows/a11y-conformance.yml) and its result is
 * copied into the image as `conformance.json`, next to this file. This module
 * locates and shape-checks that file; the verdict logic lives in the check
 * (checks/eaa/art4-product-surfaces-conformance.js).
 *
 *   loadConformance({ path?, now? }) → {
 *     found: boolean,
 *     path: string,               // where it looked (last candidate when absent)
 *     artefact: object|null,      // parsed document when found and well-formed
 *     problems: string[],         // shape problems — a non-empty list means "unusable"
 *     age_days: number|null,      // now − generated_at
 *   }
 *
 * Lookup order: `A11Y_CONFORMANCE_PATH` env → `<this dir>/conformance.json`.
 * The schema is documented in conformance.schema.json; validation here is a
 * hand-rolled subset (no ajv dependency) that covers what the check reads.
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const SURFACE_IDS = ['public_form', 'public_app', 'dsr', 'webpage_viewer'];
const IMPACTS = ['critical', 'serious', 'moderate', 'minor'];
const DEFAULT_PATH = path.join(__dirname, 'conformance.json');
const MAX_BYTES = 2 * 1024 * 1024;

function candidatePaths(explicit) {
    const out = [];
    if (explicit) out.push(String(explicit));
    else if (process.env.A11Y_CONFORMANCE_PATH) out.push(String(process.env.A11Y_CONFORMANCE_PATH));
    out.push(DEFAULT_PATH);
    return out;
}

function _isInt(v) { return Number.isInteger(v) && v >= 0; }

/**
 * Shape check the parts the check relies on. Returns a list of problems;
 * empty means usable.
 */
function validate(doc) {
    const problems = [];
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['not an object'];
    if (doc.schema_version !== SCHEMA_VERSION) problems.push(`schema_version must be ${SCHEMA_VERSION}`);
    if (typeof doc.build_sha !== 'string' || !/^([0-9a-fA-F]{7,64}|dev)$/.test(doc.build_sha)) problems.push('build_sha missing or not a git sha');
    if (typeof doc.generated_at !== 'string' || !Number.isFinite(Date.parse(doc.generated_at))) problems.push('generated_at missing or not a date-time');
    if (!Array.isArray(doc.surfaces) || doc.surfaces.length === 0) {
        problems.push('surfaces must be a non-empty array');
        return problems;
    }
    doc.surfaces.forEach((s, i) => {
        const at = `surfaces[${i}]`;
        if (!s || typeof s !== 'object') { problems.push(`${at} not an object`); return; }
        if (!SURFACE_IDS.includes(s.id)) problems.push(`${at}.id unknown (${s.id})`);
        if (!['tested', 'skipped'].includes(s.status)) problems.push(`${at}.status must be tested|skipped`);
        if (s.status === 'tested') {
            const v = s.violations;
            if (!v || typeof v !== 'object') problems.push(`${at}.violations missing`);
            else for (const k of IMPACTS) if (!_isInt(v[k])) problems.push(`${at}.violations.${k} must be a non-negative integer`);
            if (!Array.isArray(s.rules)) problems.push(`${at}.rules must be an array`);
            else s.rules.forEach((r, j) => {
                if (!r || typeof r.id !== 'string') problems.push(`${at}.rules[${j}].id missing`);
                if (!IMPACTS.includes(r?.impact)) problems.push(`${at}.rules[${j}].impact invalid`);
            });
        }
    });
    return problems;
}

/**
 * @param {{ path?: string, now?: number }} [opts]
 */
function loadConformance(opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const candidates = candidatePaths(opts.path);
    let lastPath = candidates[candidates.length - 1];
    for (const p of candidates) {
        lastPath = p;
        let raw;
        try {
            const stat = fs.statSync(p);
            if (!stat.isFile()) continue;
            if (stat.size > MAX_BYTES) {
                return { found: true, path: p, artefact: null, problems: [`file larger than ${MAX_BYTES} bytes`], age_days: null };
            }
            raw = fs.readFileSync(p, 'utf8');
        } catch {
            continue; // absent → next candidate
        }
        let doc;
        try {
            doc = JSON.parse(raw);
        } catch (e) {
            return { found: true, path: p, artefact: null, problems: [`invalid JSON: ${String(e.message).slice(0, 120)}`], age_days: null };
        }
        const problems = validate(doc);
        const generated = problems.length ? NaN : Date.parse(doc.generated_at);
        const ageDays = Number.isFinite(generated) ? Math.max(0, (now - generated) / 86400e3) : null;
        return { found: true, path: p, artefact: problems.length ? null : doc, problems, age_days: ageDays };
    }
    return { found: false, path: lastPath, artefact: null, problems: [], age_days: null };
}

/** Sum of violations per impact over the tested surfaces. */
function totals(artefact) {
    const sum = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    for (const s of artefact?.surfaces || []) {
        if (s.status !== 'tested' || !s.violations) continue;
        for (const k of IMPACTS) sum[k] += Number(s.violations[k]) || 0;
    }
    return sum;
}

module.exports = { loadConformance, validate, totals, SURFACE_IDS, IMPACTS, SCHEMA_VERSION, DEFAULT_PATH };
