/**
 * The Blueprint format: a Solution, written down so it can be installed
 * somewhere else.
 *
 * ── The one thing that is genuinely new ────────────────────────────────────
 *
 * Every packaging path this product already has — App Studio templates,
 * automation export, the CMS bundle — nulls out cross-entity pointers and tells
 * the recipient to rewire. That is the correct call when you are shipping ONE
 * thing. A Blueprint ships a set of things that were built to call each other,
 * and if the app arrives no longer knowing which automation it runs, the install
 * is inert and the feature is pointless.
 *
 * So a pointer at something INSIDE the bundle becomes `{ $ref: 'aut_1' }`, and
 * install resolves it in a second pass once every entity has a real id. This is
 * deliberately the same vocabulary templateInstall.resolveSeedRow already
 * speaks for seed-row relations — one `$ref` idea in the product, not two.
 *
 * A pointer at something OUTSIDE the bundle keeps the existing behaviour: it is
 * nulled by the shared scrub and reported under `requires`, because it is a
 * dependency the installer has to satisfy and pretending otherwise produces a
 * Blueprint that looks complete and does nothing.
 *
 * ORDER MATTERS, and it is the reason both halves work: rewrite in-bundle
 * pointers to `$ref` FIRST, then scrub. The scrub only ever sees the references
 * that could not be resolved locally, which is exactly the set that should be
 * nulled.
 *
 * ── Approvals are not entities here ────────────────────────────────────────
 *
 * An `automation_approvals` row is a decision: a person, a timestamp, an audit
 * trail. Exporting one would be exporting somebody's signature. What travels is
 * the POLICY, which already lives inside the automation's approval step and the
 * app's request_approval action — minus the seats, which the scrub removes
 * because seats are people. Approvals appear in the report and as a
 * `requires: { kind: 'approver' }` entry, never as data.
 */

'use strict';

const FORMAT = 'beeflow.blueprint';
// 2 adds `solution.slots` and `solution.variables` (pipeline releases). A
// version-1 file still reads: neither section is required.
const SCHEMA_VERSION = 2;
const SUPPORTED_VERSIONS = [1, 2];

/** Bundle-local reference prefixes, one per entity kind. */
const REF_PREFIX = {
    automations: 'aut', apps: 'app', webpages: 'web',
    datatables: 'dt', agents: 'agt', knowledgeBases: 'kb',
    skills: 'skl', documents: 'doc',
};

/** The entity lists a Blueprint carries, in the order install creates them. */
// Skills come before the agents and automations that attach them are patched, and
// document templates before the `fill_document` steps that name them: install
// resolves pointers in a second pass, so the order of CREATION is what matters,
// not the order of reading.
const ENTITY_KINDS = Object.freeze([
    'automations', 'apps', 'webpages', 'datatables', 'agents', 'knowledgeBases', 'skills', 'documents',
]);

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** The numeric tail of a ref (`aut_7` → 7), or 0 when it has none. */
function refNumber(ref, prefix) {
    const m = typeof ref === 'string' ? ref.match(new RegExp(`^${prefix}_(\\d+)$`)) : null;
    return m ? Number(m[1]) : 0;
}

/**
 * Assign every entity a bundle-local reference.
 *
 * Without `refs`: positional (`aut_1`, `aut_2`) over store order, so a
 * Blueprint says nothing about the ids of the installation that produced it.
 *
 * With `refs` (a Map entityId → ref, from the ref ledger): each entity keeps
 * the ref the ledger gave it, so the same automation is `aut_3` in every release
 * however the store happens to order the list. A member the map does not know
 * gets the next free number for its prefix, counted over EVERY ref in the map,
 * so a retired ref is never handed to somebody else.
 */
function assignRefs(members = {}, { refs = null } = {}) {
    const refByEntityId = new Map();
    const known = refs instanceof Map ? refs : (isObject(refs) ? new Map(Object.entries(refs)) : null);
    for (const kind of ENTITY_KINDS) {
        const prefix = REF_PREFIX[kind];
        const list = (Array.isArray(members[kind]) ? members[kind] : []).filter(Boolean);
        if (!known) {
            list.forEach((entity, i) => refByEntityId.set(entity.id, `${prefix}_${i + 1}`));
            continue;
        }
        let max = 0;
        for (const ref of known.values()) max = Math.max(max, refNumber(ref, prefix));
        for (const entity of list) {
            const ref = known.get(entity.id);
            refByEntityId.set(entity.id, typeof ref === 'string' && ref ? ref : `${prefix}_${++max}`);
        }
    }
    return refByEntityId;
}

/**
 * Turn in-bundle pointers into `{ $ref }`. Mutates; returns what it rewrote.
 *
 * Anything not in `refByEntityId` is left exactly as it was, for the scrub to
 * null and the report to name. The locations themselves live in pointers.js,
 * the one registry capture, install and the stage checks share; this keeps the
 * signature the callers already use.
 */
function rewriteToRefs({ appDefinition = null, automationDefinition = null, webpageBridgeGrants = null }, refByEntityId) {
    const { toRefs } = require('./pointers');
    const rewritten = [];
    const take = (list) => { for (const r of list) rewritten.push({ from: r.from, ref: r.ref }); };
    if (isObject(appDefinition)) take(toRefs('app', { definition: appDefinition }, refByEntityId));
    if (isObject(automationDefinition)) take(toRefs('automation', { definition: automationDefinition }, refByEntityId));
    if (isObject(webpageBridgeGrants)) take(toRefs('webpage', { bridgeGrants: webpageBridgeGrants }, refByEntityId));
    return rewritten;
}

/** Every bundle-local reference a manifest actually uses. */
function collectRefs(manifest) {
    const refs = new Set();
    const visit = (node) => {
        if (Array.isArray(node)) { node.forEach(visit); return; }
        if (!isObject(node)) return;
        if (typeof node.$ref === 'string') { refs.add(node.$ref); return; }
        Object.values(node).forEach(visit);
    };
    visit(manifest?.solution?.entities);
    return refs;
}

/**
 * Resolve `{ $ref }` back to real ids — the install direction of rewriteToRefs.
 *
 * Returns a NEW value rather than mutating, because install runs this over
 * payloads it is about to hand to the normal save paths and a half-rewritten
 * object reaching one of those would be worse than an unresolved reference.
 *
 * A ref with no entry in `refMap` becomes null and is named in `unresolved`.
 * That is the same answer capture gives an out-of-bundle pointer, and for the
 * same reason: a dangling id with a plausible shape is worse than an empty one
 * the editor can ask about.
 */
function rewriteRefs(value, refMap, unresolved = []) {
    if (Array.isArray(value)) return value.map(v => rewriteRefs(v, refMap, unresolved));
    if (!isObject(value)) return value;
    if (typeof value.$ref === 'string') {
        const real = refMap.get(value.$ref);
        if (real === undefined) { unresolved.push(value.$ref); return null; }
        return real;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewriteRefs(v, refMap, unresolved);
    return out;
}

// ── `source`: waar dit bestand zegt vandaan te komen ────────────────────────
//
// EEN BEWERING, GEEN AUTORISATIE. Dit blok wordt door de exportroute gestempeld
// en reist daarna in een bestand dat iedereen met een teksteditor kan wijzigen.
// Elke lezer moet het dus behandelen als invoer van buiten:
//
//   • `orgId` en `orgName` geven NOOIT toegang tot iets. De enige vraag die
//     toegang beslist is `blueprintStore.canRead` over de ECHTE galerijrij; een
//     bestand dat beweert uit org X te komen krijgt daarmee geen enkel recht
//     dat het zonder die bewering niet had.
//   • `orgName` is een NAAM UIT EEN BESTAND. Het scherm mag hem tonen — de
//     ontvanger wil weten wie beweert dit gestuurd te hebben — maar alleen
//     gelabeld als bewering, nooit als vastgesteld feit.
//   • `blueprintId` wordt bij een BESTANDSinstallatie wél vastgelegd, omdat het
//     de enige manier is waarop een installatie uit een doorgestuurd bestand
//     zichzelf aan zijn Blueprint kan koppelen. Wijst hij nergens naar, dan
//     leest hij als ONBEKEND — precies zoals een verwijderde Blueprint.
//
// De genormaliseerde vorm is er ALTIJD (met nulls waar niets bekend is), zodat
// een lezer nooit hoeft te raden tussen "geen bron" en "oud bestand".

/** Hoe lang een bewering uit een bestand mag zijn voor hij wordt afgekapt. */
const MAX_CLAIM_CHARS = { id: 64, name: 200 };

function claimText(value, max) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * Het `source`-blok van een manifest, als genormaliseerde BEWERING.
 *
 * Eén plek die beslist wat een herkomstbewering mag bevatten, zodat geen enkele
 * lezer `manifest.source.orgName` rechtstreeks aanraakt: een object, een array
 * of een tienduizend tekens lange naam wordt hier een null of een afgekapte
 * string, en nergens anders.
 */
function readSource(manifest) {
    const raw = isObject(manifest) && isObject(manifest.source) ? manifest.source : {};
    const version = Number(raw.version);
    return {
        blueprintId: claimText(raw.blueprintId, MAX_CLAIM_CHARS.id),
        orgId: claimText(raw.orgId, MAX_CLAIM_CHARS.id),
        orgName: claimText(raw.orgName, MAX_CLAIM_CHARS.name),
        version: Number.isInteger(version) && version > 0 ? version : null,
    };
}

/**
 * Een KOPIE van dit manifest met een nieuw herkomstblok.
 *
 * Gestempeld door de exportroute en niet door `captureSolution`, om twee
 * redenen die allebei over volgorde gaan: het Blueprint-id bestaat pas nadat de
 * publicatie geslaagd is, en de naam van de organisatie is niets wat een
 * capture hoort te lezen — die kent alleen het project.
 */
function withSource(manifest, source) {
    if (!isObject(manifest)) return manifest;
    return { ...manifest, source: readSource({ source }) };
}

/**
 * Assemble the manifest.
 *
 * Entities arrive already captured and already scrubbed — this function
 * assembles and never inspects payloads for secrets, because a format module
 * that also decided what was safe would be a second scrub list, and the whole
 * point of projects/packaging/scrub.js is that there is only one.
 *
 * `exportedAt` is passed in rather than read from the clock so the result is a
 * pure function of its inputs and can be asserted whole.
 */
function buildManifest({
    project, entities = {}, requires = [], report = {}, exportedAt = null,
    key = null, version = 1, source = null, slots = null, variables = null,
} = {}) {
    const p = project || {};
    const manifest = {
        format: FORMAT,
        schemaVersion: SCHEMA_VERSION,
        exportedAt: exportedAt || null,
        source: readSource({ source }),
        solution: {
            key: key || `sol_${p.id || 'unknown'}`,
            version: Number.isInteger(version) && version > 0 ? version : 1,
            name: typeof p.name === 'string' ? p.name : '',
            description: typeof p.description === 'string' ? p.description : '',
            icon: p.icon || null,
            color: p.color || null,
            customInstructions: typeof p.customInstructions === 'string' ? p.customInstructions : '',
            requires,
            entities: Object.fromEntries(ENTITY_KINDS.map(k => [k, entities[k] || []])),
            report,
        },
    };
    // Only a pipeline release has these two sections; a gallery file is
    // exactly what it was before they existed.
    if (Array.isArray(slots)) manifest.solution.slots = slots;
    if (Array.isArray(variables)) manifest.solution.variables = variables;
    return manifest;
}

/**
 * Sections that may never sit in a manifest (D20). Reference rows and a KB's
 * document listing live in `solution_release_payloads`, are pruned with their
 * release and never leave the instance; a manifest is a file that can.
 */
const FORBIDDEN_SECTIONS = ['referenceRows', 'knowledgeContent'];

/**
 * Check `solution.slots` and `solution.variables`. Both name a part with a
 * PLAIN `ref` string, never `{ $ref }`: they describe the release, they are not
 * a pointer install resolves, so collectRefs never sees them. A slot that names
 * a part the file does not carry is refused, like a dangling `$ref`.
 */
function checkPipelineSections(solution, declared, errors) {
    for (const [section, label] of [['slots', 'slot'], ['variables', 'variable']]) {
        const list = solution[section];
        if (list === undefined) continue;
        if (!Array.isArray(list)) { errors.push(`The Blueprint's ${section} section is not a list.`); continue; }
        for (const item of list) {
            if (!isObject(item)) { errors.push(`A ${label} in the Blueprint is not an object.`); continue; }
            if (section === 'slots' && (typeof item.slot !== 'string' || !item.slot)) errors.push('A slot in the Blueprint has no name.');
            if (section === 'variables' && (typeof item.name !== 'string' || !item.name)) errors.push('A variable in the Blueprint has no name.');
            if (item.ref === undefined || item.ref === null) {
                if (section === 'slots') errors.push(`The slot "${item.slot}" does not say which part it belongs to.`);
                continue;
            }
            if (typeof item.ref !== 'string') {
                errors.push(`The ${label} "${item.slot || item.name}" names its part with something other than a plain ref.`);
            } else if (!declared.has(item.ref)) {
                errors.push(`The ${label} "${item.slot || item.name}" belongs to "${item.ref}", which the Blueprint does not contain.`);
            }
        }
    }
}

/**
 * Two classes of key that must not survive a trip through this format, whatever
 * produced the file.
 *
 *   `fixedArgs`  — author-supplied arguments to an integration call. They can
 *                  hold a path, an id, a token or a whole request body, and the
 *                  installer is meant to re-authorise the tool rather than
 *                  inherit its arguments.
 *   `ai.public*` — the half of a page's bridge grants that decides whether
 *                  ANONYMOUS visitors may spend the page owner's AI budget, and
 *                  up to how much (bridgeGrants.js clamps the cap at $50/day).
 *                  A Blueprint that carried `publicEnabled: true` would arm
 *                  public spending on the INSTALLER's account before they had
 *                  even opened the page.
 *
 * Matched by SHAPE, not by a list of known names: every key under an `ai`
 * object whose name starts with `public` goes, so a `publicSomethingNew` added
 * to bridgeGrants next year is stripped by the rule that was written before it
 * existed.
 */
function stripNeverInstallable(value, parentKey = null) {
    if (Array.isArray(value)) return value.map(v => stripNeverInstallable(v, parentKey));
    if (!isObject(value)) return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (k === 'fixedArgs') continue;
        if (parentKey === 'ai' && /^public/.test(k)) continue;
        out[k] = stripNeverInstallable(v, k);
    }
    return out;
}

/**
 * Accept a manifest from outside, or say precisely why not — and hand back a
 * copy with the two never-installable key classes removed.
 *
 * Refused rather than repaired: a Blueprint whose refs do not resolve would
 * install a set of entities that do not know about each other, which is the
 * exact failure this format exists to prevent, and it would fail silently.
 *
 * ── Why this module strips, when it used to only inspect ───────────────────
 *
 * The rule this file kept was that a format module must not decide what is
 * safe, because that would be a second scrub list beside
 * projects/packaging/scrub.js. That rule still holds for JUDGEMENT — what a
 * table's columns may say, which agent config keys travel, whether a seat is a
 * person — and all of that still lives in scrub.js alone.
 *
 * These two classes are different in kind: they are not a judgement about
 * content, they are keys that CANNOT be installed under any circumstances,
 * from any source. Capture already removes them (scrub.captureBridgeGrants) and
 * install already writes safe defaults over them, but between those two sits a
 * file a person can edit by hand, and that file reaches install through here.
 * A choke point every reader passes is exactly where an absolute rule belongs.
 *
 * `install.js` and `upgrade.js` therefore build from `checked.manifest`, which
 * is a stripped COPY — the caller's own object is never mutated, so a caller
 * that also keeps the file it read still has what it read.
 */
function sanitizeManifest(rawInput) {
    const input = isObject(rawInput) ? stripNeverInstallable(rawInput) : rawInput;
    const errors = [];
    if (!isObject(input)) return { ok: false, errors: ['That is not a Blueprint file.'] };
    // Het herkomstblok wordt hier GENORMALISEERD en niet geweigerd: een
    // onzinnige bewering is geen reden om een verder geldige Blueprint niet te
    // installeren, en de bewering geeft toch geen enkel recht. Wat er wél
    // gebeurt is dat elke lezer voorbij dit punt een blok met vier velden ziet
    // — strings of null — in plaats van wat het bestand ook maar meestuurde.
    input.source = readSource(input);
    if (input.format !== FORMAT) errors.push(`Expected a ${FORMAT} file.`);
    if (!SUPPORTED_VERSIONS.includes(input.schemaVersion)) {
        errors.push(`Blueprint format version ${input.schemaVersion} is not supported here (this install reads ${SUPPORTED_VERSIONS.join(', ')}).`);
    }
    const solution = input.solution;
    if (!isObject(solution)) errors.push('The Blueprint has no solution in it.');
    for (const section of FORBIDDEN_SECTIONS) {
        if (input[section] !== undefined || (isObject(solution) && solution[section] !== undefined)) {
            errors.push(`A Blueprint may not carry "${section}": that content stays on this installation.`);
        }
    }
    if (errors.length) return { ok: false, errors };

    const entities = isObject(solution.entities) ? solution.entities : {};
    const declared = new Set();
    for (const kind of ENTITY_KINDS) {
        for (const e of (Array.isArray(entities[kind]) ? entities[kind] : [])) {
            if (isObject(e) && typeof e.ref === 'string') declared.add(e.ref);
        }
    }
    for (const ref of collectRefs(input)) {
        if (!declared.has(ref)) errors.push(`The Blueprint points at "${ref}", which it does not contain.`);
    }
    checkPipelineSections(solution, declared, errors);
    if (errors.length) return { ok: false, errors };

    return { ok: true, manifest: input, refs: declared };
}

module.exports = {
    FORMAT, SCHEMA_VERSION, SUPPORTED_VERSIONS, REF_PREFIX, ENTITY_KINDS, FORBIDDEN_SECTIONS,
    assignRefs, rewriteToRefs, rewriteRefs, collectRefs, buildManifest, sanitizeManifest,
    stripNeverInstallable, readSource, withSource,
};
