/**
 * App Studio — an app template as a FILE, so it can leave one installation and
 * arrive at another.
 *
 *   buildExport(template, { exportedAt, source })  → { envelope, warnings }
 *   sanitizeImport(envelope)                       → { template, report, errors, warnings }
 *
 * Both are PURE (no database, no network), like automation/portability.js —
 * routes/studioApps.js stays the only place with side effects, and the rules
 * worth arguing about are testable with plain objects.
 *
 * ── Why this exists, given that templateCapture.js said it should not ──────
 *
 * templateCapture.js opens with "there is no second installer and no 'import a
 * definition blob' back door", and that sentence was right about the thing it
 * was refusing: a route that took a JSON definition and wrote it somewhere,
 * skipping the gate every other template passes through. This module is not
 * that. It is a FORMAT — a way to write a template down and read it back — and
 * the reading end hands what it read to `captureTemplate`, the same gate a
 * capture from a live app goes through, with the same scrub, the same
 * canonicalize, the same validate, the same ceiling. An imported template then
 * installs by `templateInstall.installTemplate` like every other one.
 *
 * So the invariant holds and gets one more clause: a template can now be BORN
 * three ways (code, captured, imported) and there is still exactly ONE way for
 * it to become an app.
 *
 * ── The asymmetry, and why it is deliberate ───────────────────────────────
 *
 * Export is small: an allow-list copy, a scrub, a provenance stamp. Import is
 * large: it re-decides everything. That is not duplication that drifted, it is
 * the difference between data this installation produced and data a stranger
 * sent. Export cannot make the file safe for the recipient — only the
 * recipient's own gate can do that, because only it knows what "safe" means
 * there. Export's job is to not leak on the way OUT; import's job is to not
 * trust on the way IN. A file that was hand-written, edited after export, or
 * produced by a build of this product from two years ago all arrive at the same
 * door and get the same treatment.
 *
 * ── What never travels ────────────────────────────────────────────────────
 *
 * The scrub list is shared (projects/packaging/scrub.js), so what a Blueprint
 * refuses to carry an app template refuses to carry too: routine ids, approver
 * seats, knowledge-base references. On top of that this module drops the two
 * key classes manifest.js calls never-installable — an integration call's
 * `fixedArgs` and any `ai.public*` flag — by calling its function rather than
 * writing a second list that would disagree with the first one within a year.
 *
 * The instance-local half of a stored template (`id`, `createdBy`,
 * `sourceAppId`, `organizationId`, timestamps) is not copied: an allow-list, so
 * a column added to `studio_app_templates` next year does not start travelling
 * because nobody remembered this file.
 *
 * ── The provenance block is a CLAIM ───────────────────────────────────────
 *
 * `source` says where the file says it came from. It is normalised (four
 * fields, strings or null, capped) and it is never believed: it grants nothing,
 * decides nothing, and is shown to the person doing the import so they can
 * judge the file the way they would judge its sender. Same treatment, and for
 * the same reason, as a Blueprint's own source block.
 */

'use strict';

const EXPORT_FORMAT = 'beeflow.apptemplate';
const EXPORT_SCHEMA_VERSION = 1;

/**
 * Every version this server can still READ, newest last.
 *
 * A ladder rather than an equality check, for the reason automation/
 * portability.js states: the moment the version is bumped, strict equality
 * starts rejecting every file yesterday's build wrote, including the user's own
 * backups. Adding an older number here is then the whole migration for a purely
 * additive change.
 */
const EXPORT_SUPPORTED_VERSIONS = [1];

/** What a template is allowed to carry across the wire. Nothing else does. */
const TEMPLATE_PAYLOAD_FIELDS = ['definition', 'dataModel', 'seed', 'seedPeople', 'datasets'];
const TEMPLATE_META_FIELDS = ['version', 'title', 'description', 'category', 'icon', 'tags'];

/** How long a claim out of a file may be before it is cut. */
const MAX_CLAIM_CHARS = { id: 64, name: 200 };

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function deepClone(value) {
    if (value === null || typeof value !== 'object') return value;
    try { return structuredClone(value); }
    catch { return JSON.parse(JSON.stringify(value)); }
}

function claimText(value, max) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * The `source` block, as a normalised CLAIM — the one place that decides what a
 * provenance assertion may contain, so no reader downstream ever touches
 * `envelope.source.orgName` raw. An object, an array or a ten-thousand
 * character name becomes a null or a cut string here and nowhere else.
 */
function readSource(envelope) {
    const raw = isObject(envelope) && isObject(envelope.source) ? envelope.source : {};
    const version = Number(raw.version);
    return {
        templateId: claimText(raw.templateId, MAX_CLAIM_CHARS.id),
        orgId: claimText(raw.orgId, MAX_CLAIM_CHARS.id),
        orgName: claimText(raw.orgName, MAX_CLAIM_CHARS.name),
        version: Number.isInteger(version) && version > 0 ? version : null,
    };
}

/** A filename a browser will accept, derived from the template's own title. */
function exportFilename(template) {
    const title = (template && typeof template.title === 'string') ? template.title : 'app-template';
    const slug = title.toLowerCase().normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'app-template';
    return `${slug}.beeflow-app.json`;
}

/**
 * buildExport — write a template down.
 *
 * `template` is whatever templateRegistry.resolveTemplate returns: a built-in
 * entry (code) or a captured row's payload. Both have the same keys by
 * construction, which is the whole reason the registry exists, so there is no
 * branch here on which kind it is.
 *
 * The scrub runs on the way out even though both kinds were already scrubbed —
 * a built-in by review, a captured one by templateCapture. It costs one walk
 * and it closes the window where a template was written by an older build, or
 * by a path that gains a reference next year. What it clears is reported, not
 * swallowed: the person exporting learns their template referenced a routine
 * that the recipient will have to wire up.
 */
function buildExport(template, { exportedAt = null, source = null } = {}) {
    const warnings = [];
    if (!isObject(template)) {
        return { envelope: null, warnings: ['There is no template to export.'] };
    }

    const out = {};
    for (const field of TEMPLATE_META_FIELDS) {
        if (template[field] !== undefined) out[field] = deepClone(template[field]);
    }
    for (const field of TEMPLATE_PAYLOAD_FIELDS) {
        if (template[field] !== undefined) out[field] = deepClone(template[field]);
    }
    out.version = Number.isInteger(template.version) && template.version > 0 ? template.version : 1;
    out.title = claimText(template.title, 80) || 'App template';
    out.tags = Array.isArray(out.tags) ? out.tags.filter((t) => typeof t === 'string') : [];

    // The two key classes no packaging format in this product carries, applied
    // by manifest.js's own function so there is one list and not two.
    const { stripNeverInstallable } = require('../projects/packaging/manifest');
    const stripped = stripNeverInstallable(out);

    // The shared scrub, on the definition only — the model and the seed carry
    // no cross-entity pointers (a relation is an in-file `$ref` by then).
    const { scrubAppDefinition, RULES } = require('../projects/packaging/scrub');
    if (isObject(stripped.definition)) {
        const report = scrubAppDefinition(stripped.definition);
        const automations = report.filter((r) => r.rule === RULES.APP_AUTOMATION_REFERENCE).length;
        const seats = report.filter((r) => r.rule === RULES.APP_APPROVER_IDENTITY).length;
        const bases = report.filter((r) => r.rule === RULES.APP_KNOWLEDGE_BASE_REFERENCE).length;
        if (automations) warnings.push(`${automations} routine reference(s) removed — whoever installs this connects their own.`);
        if (seats) warnings.push(`${seats} approver seat(s) removed: a seat names a real person in this organisation.`);
        if (bases) warnings.push(`${bases} knowledge-base reference(s) removed: they name internal resources of this organisation.`);
    }

    return {
        envelope: {
            format: EXPORT_FORMAT,
            schemaVersion: EXPORT_SCHEMA_VERSION,
            exportedAt: exportedAt || null,
            source: readSource({ source }),
            template: stripped,
        },
        warnings,
    };
}

/**
 * sanitizeImport — read a template back, and say precisely why not.
 *
 * Four stages, in this order and for this reason:
 *
 *   1. FORMAT. Refuse anything that does not claim to be this format at a
 *      version this build reads, before a single key is looked at. "That is not
 *      an app template" is a better answer than a validation error about a
 *      screen, when the file was a holiday photo.
 *   2. ALLOW-LIST. Copy the named fields and nothing else, so a key added to
 *      the format later cannot ride in on a build that does not know it.
 *   3. STRIP. The never-installable key classes, shared with manifest.js.
 *   4. THE GATE. captureTemplate — scrub, canonicalize, validate, ceiling. Its
 *      errors are this function's errors; its report is this function's report.
 *
 * `template.id` from the file is deliberately not read at all. An id is where
 * the template lived, not what it is, and the store mints a fresh one — so
 * importing the same file twice gives two templates rather than a collision
 * with, or an overwrite of, whatever `utpl_…` happens to exist here.
 */
function sanitizeImport(envelope) {
    if (!isObject(envelope)) {
        return { template: null, report: null, errors: ['That file is not an app template.'], warnings: [] };
    }
    if (envelope.format !== EXPORT_FORMAT) {
        return {
            template: null, report: null, warnings: [],
            errors: [`That file is not an app template (expected a ${EXPORT_FORMAT} file).`],
        };
    }
    if (!EXPORT_SUPPORTED_VERSIONS.includes(envelope.schemaVersion)) {
        return {
            template: null, report: null, warnings: [],
            errors: [`App template format version ${envelope.schemaVersion} is not supported here (this installation reads ${EXPORT_SUPPORTED_VERSIONS.join(', ')}).`],
        };
    }

    const raw = isObject(envelope.template) ? envelope.template : null;
    if (!raw) {
        return { template: null, report: null, warnings: [], errors: ['The file carries no template.'] };
    }

    const { stripNeverInstallable } = require('../projects/packaging/manifest');
    const incoming = stripNeverInstallable(deepClone(raw));

    const { captureTemplate } = require('./templateCapture');
    const result = captureTemplate({
        definition: incoming.definition,
        dataModel: isObject(incoming.dataModel) ? incoming.dataModel : null,
        // The seed arrives already written down; normalizeSeed inside the gate
        // re-decides every value in it against the model.
        seed: isObject(incoming.seed) ? incoming.seed : null,
        seedPeople: isObject(incoming.seedPeople) ? incoming.seedPeople : null,
        datasets: Array.isArray(incoming.datasets) ? incoming.datasets : [],
        meta: {
            // No `id`: see the header. Version restarts at 1 in its new home for
            // the same reason — version is a statement about a line of edits,
            // and this is the first one here.
            title: incoming.title,
            description: incoming.description,
            category: incoming.category,
            icon: incoming.icon,
            tags: incoming.tags,
            version: 1,
        },
    });

    if (!result.ok) {
        return { template: null, report: null, warnings: [], errors: result.errors };
    }
    return {
        template: result.template,
        report: { ...result.report, source: readSource(envelope), exportedAt: claimText(envelope.exportedAt, 64) },
        errors: [],
        warnings: result.report.warnings || [],
    };
}

module.exports = {
    EXPORT_FORMAT,
    EXPORT_SCHEMA_VERSION,
    EXPORT_SUPPORTED_VERSIONS,
    TEMPLATE_META_FIELDS,
    TEMPLATE_PAYLOAD_FIELDS,
    buildExport,
    sanitizeImport,
    exportFilename,
    readSource,
};
