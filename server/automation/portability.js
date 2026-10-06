'use strict';

/**
 * Automation import/export — the WS6 portability layer.
 *
 *   buildExport(automation)        → { envelope, warnings }
 *   sanitizeImport(envelope)       → { automation, errors }
 *   rebindDatatables(def, tables)  → { relinked, entries }
 *   rekeyDefinition(def)           → { definition, renameMap }
 *
 * All four are PURE (no DB, no network) so routes/automation.js stays the
 * only place with side effects and the functions are trivially testable —
 * which is why rebindDatatables is HANDED the importing scope's tables rather
 * than looking them up: the caller owns the scope, so a re-bind cannot reach
 * past it.
 *
 * Export is an ALLOWLIST copy: only { title, description, triggerType,
 * scheduleCron, scheduleTz, definition } ever leave the server. Row ids,
 * userId/organizationId, builderSession (the full AI-chat transcript!),
 * createdFromChatId, run-lock columns, version counters and webhook rows are
 * deliberately never serialized. Pinned step outputs (`step.pinnedOutput`,
 * n8n-style captured live data) are stripped from the definition — they're
 * snapshots of THIS user's data and would otherwise ride into someone else's
 * install; each removal is reported in the returned warnings array. That
 * sweep covers TRIGGERS as well as steps (BFSF-408 gave a trigger a pinned
 * sample too), and takes the whole pin — `pinnedAt` and `pinnedSource` with it.
 *
 * Import mirrors the allowlist (unknown fields are silently dropped) and
 * gates on the envelope format/schemaVersion. Step ids are re-keyed on
 * import (rekeyDefinition) so a file imported twice — or a file crafted to
 * collide with existing drafts — always lands with fresh ids.
 *
 * Inline layers (definition.layers) ride along naturally in the definition.
 * Re-keying runs PER GRAPH: the root document and every layers[key]
 * mini-definition get independent rename maps, because bindings inside a
 * layer reference same-layer step ids (see validate.js validateGraph). Layer
 * KEYS are stable identifiers (call_layer.layerKey) and stay unchanged.
 */

const crypto = require('crypto');

const EXPORT_FORMAT = 'beeflow.automation';
const EXPORT_SCHEMA_VERSION = 1;
/**
 * Every version this server can still READ, newest last.
 *
 * A ladder rather than an equality check, established before it is first
 * needed: the moment the version is bumped, strict equality would start
 * rejecting every file exported by yesterday's build — including the user's
 * own backups. Adding an older number here is then the whole migration for a
 * purely additive change, and cmsStore.js does the same thing for site
 * bundles.
 */
const EXPORT_SUPPORTED_VERSIONS = [1];

function isObject(x) { return x && typeof x === 'object' && !Array.isArray(x); }

function deepClone(value) {
    if (value === null || typeof value !== 'object') return value;
    try { return structuredClone(value); }
    catch { return JSON.parse(JSON.stringify(value)); }
}

// ── Step walking (shared) ───────────────────────────────
//
// Steps nest inside loop bodies and parallel branches (same shapes
// validate.js collectCallLayerSteps walks); everything else is flat.

function walkSteps(steps, fn) {
    if (!Array.isArray(steps)) return;
    for (const s of steps) {
        if (!isObject(s)) continue;
        fn(s);
        if (s.type === 'loop') walkSteps(s.body, fn);
        if (s.type === 'parallel' && Array.isArray(s.branches)) {
            for (const branch of s.branches) walkSteps(branch, fn);
        }
    }
}

/**
 * Every TRIGGER of one graph — the primary `trigger`, then each extra entry
 * point in `triggers[]`. Both are nodes of the graph the canvas draws and both
 * can carry the same author-supplied fields a step can.
 */
function walkTriggers(graph, layerKey, fn) {
    if (isObject(graph.trigger)) fn(graph.trigger, layerKey, true);
    if (!Array.isArray(graph.triggers)) return;
    for (const t of graph.triggers) if (isObject(t)) fn(t, layerKey, true);
}

/**
 * Every NODE of every graph in a definition — the root graph, then each layer —
 * with the layer's key so a caller can say WHERE it found something, and a flag
 * saying whether the node is a trigger.
 *
 * Both sweeps below wrote this root-then-layers loop by hand, and anything else
 * that needs to read a whole definition (the Solution dependency graph, and the
 * packager after it) would have written it a third time. Nesting rules live in
 * walkSteps; this says what a definition is made of. One place each.
 *
 * TRIGGERS were missing from that answer until BFSF-408. Steps were the only
 * things that could carry pinned sample data, so "every step" and "every node
 * that can hold one of this user's captured payloads" were the same set — and
 * the moment a trigger could be pinned too, the export sweep 40 lines below
 * stopped covering the thing it promises to cover, silently. A trigger is a
 * node of the graph; this walker says so, and every consumer that only cares
 * about steps is already `step.type`-guarded (they look for 'approval',
 * 'http_request', 'call_block' — a trigger is type 'trigger', so visiting one
 * is a no-op for them).
 */
function walkAllSteps(definition, fn) {
    if (!isObject(definition)) return;
    walkTriggers(definition, null, fn);
    walkSteps(definition.steps, (s) => fn(s, null, false));
    if (!isObject(definition.layers)) return;
    for (const [key, layer] of Object.entries(definition.layers)) {
        if (!isObject(layer)) continue;
        walkTriggers(layer, key, fn);
        walkSteps(layer.steps, (s) => fn(s, key, false));
    }
}

// ── Export ──────────────────────────────────────────────

/**
 * Every field that makes up a pin. `pinnedOutput` is the captured payload
 * itself; `pinnedAt` says when it was taken and `pinnedSource` says whether the
 * author captured it from a run or typed it by hand. Listed once so a new pin
 * field cannot be added on the write side and forgotten on this one — leaving
 * behind a `pinnedAt` with no output, which reads as a corrupt pin in the
 * importer's builder and is still a timestamp from someone else's install.
 */
const PIN_FIELDS = ['pinnedOutput', 'pinnedAt', 'pinnedSource'];

/**
 * Strip the pin from every node of every graph (root + layers, steps AND
 * triggers), recording a warning per removal. Mutates `def`; returns nothing.
 */
function stripPinnedOutputs(def, warnings) {
    walkAllSteps(def, (node, layerKey, isTrigger) => {
        if (!PIN_FIELDS.some(f => node[f] !== undefined)) return;
        for (const f of PIN_FIELDS) delete node[f];
        const where = layerKey ? ` (layer "${layerKey}")` : '';
        const what = isTrigger ? 'trigger' : 'step';
        warnings.push(`Removed pinned output from ${what} "${node.id || '(no id)'}"${where} — pinned data is captured from live runs and is not portable.`);
    });
}

/**
 * Every node in a definition that currently SERVES pinned data instead of
 * running — steps and triggers, root graph and every layer.
 *
 * Read-only (the caller's definition is never touched); the activation path in
 * routes/automation/crud.js uses it to say which nodes will hand out a saved
 * sample once the automation is live, and to refuse outright when one of those
 * samples was typed by hand rather than captured from a real run.
 *
 * `pinnedSource` defaults to 'captured' for the pins that predate the field:
 * every pin written before BFSF-408 came from a real run's output.
 */
function collectPinnedNodes(definition) {
    const found = [];
    walkAllSteps(definition, (node, layerKey, isTrigger) => {
        if (node.pinnedOutput === undefined || node.pinnedOutput === null) return;
        found.push({
            id: typeof node.id === 'string' && node.id ? node.id : null,
            kind: isTrigger ? 'trigger' : 'step',
            type: typeof node.type === 'string' ? node.type : (isTrigger ? 'trigger' : null),
            layerKey: layerKey || null,
            pinnedSource: typeof node.pinnedSource === 'string' && node.pinnedSource ? node.pinnedSource : 'captured',
            pinnedAt: node.pinnedAt || null,
        });
    });
    return found;
}

/**
 * Blank out references that only mean something on the install that made them,
 * and say so in the warnings.
 *
 *  - `http_request.auth.connectionId` points at an `integration_connections`
 *    row. On another install that id is either absent (the step fails at
 *    activation, which is fine) or — far worse — belongs to somebody else's
 *    credential. Exporting it is a bad trade in both directions, so it goes.
 *  - `datatable.datatableId` — and `http_request.cacheInto.datatableId`, the
 *    second place a step names a table — name a table in ONE organisation, so
 *    the id goes and the step's `datatableKey` stays. The key is what rebindDatatables
 *    re-links on at import; without it the recipient is told to "pick a table
 *    again" with no way to know which one it was.
 *  - `call_block.blockId` names a reusable Step by row id. It cannot be
 *    rewritten (the target lives outside this document), so it is named in a
 *    warning rather than silently carried or silently dropped: import already
 *    reports `call_block.unknown_block` if it is missing, and this tells the
 *    exporter what the recipient will need.
 *  - `ai_step.knowledgeBaseIds` identifies knowledge bases in ONE organisation
 *    (BFSF-410) — same story as the datatable id, minus the key: there is no
 *    author-chosen slug to re-link an imported step by, so it is emptied and
 *    named in a warning rather than silently carried.
 *  - `knowledge_write.knowledgeBaseId` is the same id from the WRITE side, and
 *    the side it matters most on: a read that survives export finds nothing,
 *    while a write that survives it is a step adding documents to a base the
 *    recipient never chose. Emptied, with a warning of its own.
 */
function stripEnvironmentRefs(def, warnings) {
    // Credentials and people are swept by the shared rules, so this path, the
    // App Studio capture path and Blueprint packaging cannot drift about what
    // must never leave an installation. Approver seats in particular were NOT
    // being removed here before: an exported automation carried the user and group
    // ids of whoever it asked to approve, straight into the importer's install.
    const { scrubAutomationDefinition, RULES } = require('../projects/packaging/scrub');
    const where = (layerKey) => (layerKey ? ` (layer "${layerKey}")` : '');
    for (const entry of scrubAutomationDefinition(def)) {
        if (entry.rule === RULES.AUTOMATION_CONNECTION_REFERENCE) {
            warnings.push(`Cleared the saved credential on step "${entry.stepId || '(no id)'}"${where(entry.layerKey)} — credentials belong to one workspace. Pick one again after importing.`);
        }
        if (entry.rule === RULES.AUTOMATION_APPROVER_IDENTITY) {
            warnings.push(`Cleared the "${entry.field}" on the approval step "${entry.stepId || '(no id)'}"${where(entry.layerKey)} — approvers are people in one organisation. Pick them again after importing.`);
        }
        if (entry.rule === RULES.AUTOMATION_DATATABLE_REFERENCE && entry.field === 'cacheInto') {
            // The http_request step's "remember answers in a table". There is
            // no key to re-link on — the table is provisioned by the platform,
            // not named by the author — so this one is honestly "pick again".
            warnings.push(`Cleared "remember answers in a table" on step "${entry.stepId || '(no id)'}"${where(entry.layerKey)} — a datatable belongs to one organisation. Point it at a table of your own after importing, or leave it off.`);
            continue;
        }
        if (entry.rule === RULES.AUTOMATION_DATATABLE_REFERENCE) {
            // The warning NAMES the table when the step carries its key. Saying
            // only "pick a table again" left the importer with no way to know
            // which one it was — and the key is exactly what rebindDatatables
            // below matches on, so the message and the mechanism agree.
            warnings.push(entry.datatableKey
                ? `Cleared the datatable on step "${entry.stepId || '(no id)'}"${where(entry.layerKey)} — a datatable belongs to one organisation. The step still names the table by its key ("${entry.datatableKey}"), so an import into a workspace that has one re-links it; otherwise pick a table again.`
                : `Cleared the datatable on step "${entry.stepId || '(no id)'}"${where(entry.layerKey)} — a datatable belongs to one organisation, and this step does not name which one. Pick a table again after importing.`);
        }
        if (entry.rule === RULES.AUTOMATION_KNOWLEDGE_BASE_REFERENCE && entry.field === 'knowledgeBaseId') {
            // The WRITE side. Worth its own sentence: the recipient has to know
            // this step puts documents somewhere before they choose where, and
            // an automation that says nothing until it is activated says it too late.
            warnings.push(`Cleared the knowledge base this step WRITES to on step "${entry.stepId || '(no id)'}"${where(entry.layerKey)} — a knowledge base belongs to one organisation. Pick one you manage after importing; until you do, the step stores nothing.`);
            continue;
        }
        if (entry.rule === RULES.AUTOMATION_KNOWLEDGE_BASE_REFERENCE) {
            warnings.push(`Cleared the knowledge base${entry.count === 1 ? '' : 's'} on step "${entry.stepId || '(no id)'}"${where(entry.layerKey)} — a knowledge base belongs to one organisation. Pick knowledge bases again after importing.`);
        }
    }

    // Reporting only, no scrub: a call_block target lives outside this document
    // and cannot be rewritten, so the exporter says what the recipient needs.
    walkAllSteps(def, (s, layerKey) => {
        // A string blockId names a Step outside this document. A Blueprint
        // rewrites in-bundle ones to { $ref } BEFORE exporting, and those are
        // carried rather than missing — warning about them would tell the
        // recipient to go and find something the file already contains.
        if (s.type === 'call_block' && typeof s.blockId === 'string' && s.blockId) {
            // Named by its LABEL where it has one. Two row ids in one sentence
            // is a warning the exporter cannot act on — they would have to go
            // and look up which Step "block-xyz" is before they could do
            // anything about it — and the label is what the builder auto-names
            // from the Step's own title, so it is usually the Step's name.
            // The id stays, because it is what the recipient's import error
            // will quote back at them.
            const called = typeof s.label === 'string' && s.label.trim() ? `"${s.label.trim()}" (${s.blockId})` : `"${s.blockId}"`;
            warnings.push(`Step "${s.id || '(no id)'}"${where(layerKey)} calls the reusable Step ${called}, which is not part of this file. Export that Step as well and have whoever imports this bring it in first, or the call has nothing to run.`);
        }
    });
}

/**
 * Build the export envelope for one automation row (the camelCase shape
 * automationStore.rowToAutomation returns).
 *
 * @returns {{ envelope: object, warnings: string[] }} — `warnings` lists
 *          non-blocking removals (today: stripped pinned outputs).
 */
/**
 * De back-pointer naar de knop waar de automatisering vandaan komt, eraf.
 *
 * `trigger.appRef` (contract in automation/appTriggerContract.js) noemt een app,
 * een scherm en een component van ÉÉN installatie. Overgedragen wijst hij
 * nergens naar — en de triggerkaart is gebouwd om dat hardop te zeggen ("App is
 * gone"), dus een geïmporteerde automatisering zou aankomen met de melding van een
 * verwijdering die nooit heeft plaatsgevonden. Niet in de gedeelde scrub-regels:
 * dit is geen sleutel en geen persoon, alleen een label dat ophoudt waar te zijn
 * zodra het vertrekt.
 *
 * BEIDE KANTEN. Hij zat alleen op de EXPORT, en daardoor gaven de twee
 * create-paden een verschillend antwoord op dezelfde invoer: `POST /` weigert
 * een definitie met een appRef naar andermans app (403 `owner_mismatch`, zie de
 * poort in routes/automation/crud.js), terwijl `POST /import` er twee handlers
 * verderop eentje binnenliet met een handgeschreven bestand. Weigeren zou daar
 * te hard zijn — het is een label, geen recht, en de rest van het bestand is
 * prima te importeren — dus: eraf halen en het zeggen.
 *
 * @param {object} definition  wordt TER PLEKKE aangepast
 * @param {string[]} warnings  krijgt per verwijderde pointer een zin
 * @returns {number} hoeveel er zijn verwijderd
 */
function stripAppRefs(definition, warnings = []) {
    let removed = 0;
    walkAllSteps(definition, (node, layerKey, isTrigger) => {
        if (!isTrigger || node.appRef === undefined) return;
        delete node.appRef;
        removed += 1;
        warnings.push(`Removed the link back to the app button on the trigger${layerKey ? ` (layer "${layerKey}")` : ''} — it names a screen in one installation and would point at nothing here.`);
    });
    return removed;
}

function buildExport(automation) {
    const src = isObject(automation) ? automation : {};
    const warnings = [];
    const definition = deepClone(isObject(src.definition) ? src.definition : {});
    stripPinnedOutputs(definition, warnings);
    stripEnvironmentRefs(definition, warnings);
    // manualTriggerPayload is a sample payload the user captured for manual
    // test runs (real email subjects/senders, ticket bodies, etc.). It's
    // run-specific data, not part of the portable automation shape — strip it
    // so an exported/shared file can't leak the author's sample content.
    if (definition.manualTriggerPayload !== undefined) {
        delete definition.manualTriggerPayload;
        warnings.push('Removed the saved manual-trigger sample payload — it is captured from your data and is not portable.');
    }
    stripAppRefs(definition, warnings);
    const envelope = {
        format: EXPORT_FORMAT,
        schemaVersion: EXPORT_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        automation: {
            title: typeof src.title === 'string' ? src.title : '',
            description: typeof src.description === 'string' ? src.description : '',
            triggerType: typeof src.triggerType === 'string' ? src.triggerType : 'manual',
            scheduleCron: typeof src.scheduleCron === 'string' ? src.scheduleCron : null,
            scheduleTz: typeof src.scheduleTz === 'string' ? src.scheduleTz : null,
            definition,
        },
    };
    return { envelope, warnings };
}

// ── Import ──────────────────────────────────────────────

/**
 * Sanitize an uploaded import body. Accepts the full export envelope or a
 * bare `{ automation: {...} }` body (hand-built files). Returns
 * `{ automation, errors }` — `automation` is null whenever errors exist.
 *
 * The copy is allowlist-only: id/userId/organizationId/builderSession/
 * isActive/version/webhooks and any other field an older (or hostile) file
 * carries are dropped, never echoed into the create path.
 */
function sanitizeImport(envelope) {
    const errors = [];
    if (!isObject(envelope)) {
        return { automation: null, errors: ['Import body must be a JSON object.'] };
    }
    if (envelope.format !== undefined && envelope.format !== EXPORT_FORMAT) {
        errors.push(`Unknown format "${envelope.format}" — expected "${EXPORT_FORMAT}".`);
    }
    if (envelope.schemaVersion !== undefined && !EXPORT_SUPPORTED_VERSIONS.includes(envelope.schemaVersion)) {
        if (typeof envelope.schemaVersion === 'number' && envelope.schemaVersion > EXPORT_SCHEMA_VERSION) {
            errors.push(`This file uses schemaVersion ${envelope.schemaVersion}, which is newer than this server supports (${EXPORT_SCHEMA_VERSION}). Update Bee Flow, or re-export the automation from a matching version.`);
        } else {
            errors.push(`Unsupported schemaVersion ${JSON.stringify(envelope.schemaVersion)} — this server reads ${EXPORT_SUPPORTED_VERSIONS.join(', ')}.`);
        }
    }
    const src = isObject(envelope.automation) ? envelope.automation : null;
    if (!src) {
        errors.push('Missing `automation` object — expected a file produced by the automation Export action.');
    }
    if (errors.length > 0) return { automation: null, errors };

    const title = typeof src.title === 'string' ? src.title.trim() : '';
    if (!title) errors.push('automation.title must be a non-empty string.');
    if (!isObject(src.definition)) errors.push('automation.definition must be an object.');
    if (src.triggerType !== undefined && typeof src.triggerType !== 'string') {
        errors.push('automation.triggerType must be a string when present.');
    }
    if (src.scheduleCron !== undefined && src.scheduleCron !== null && typeof src.scheduleCron !== 'string') {
        errors.push('automation.scheduleCron must be a string or null.');
    }
    if (src.scheduleTz !== undefined && src.scheduleTz !== null && typeof src.scheduleTz !== 'string') {
        errors.push('automation.scheduleTz must be a string or null.');
    }
    if (errors.length > 0) return { automation: null, errors };

    return {
        automation: {
            title,
            description: typeof src.description === 'string' ? src.description : '',
            triggerType: (typeof src.triggerType === 'string' && src.triggerType.trim()) ? src.triggerType.trim() : 'manual',
            scheduleCron: (typeof src.scheduleCron === 'string' && src.scheduleCron.trim()) ? src.scheduleCron.trim() : null,
            scheduleTz: (typeof src.scheduleTz === 'string' && src.scheduleTz.trim()) ? src.scheduleTz.trim() : null,
            definition: deepClone(src.definition),
        },
        errors: [],
    };
}

// ── Re-binding datatables ───────────────────────────────

/**
 * Point every unbound datatable step at the importing scope's own table with
 * the same KEY, and say what happened to each one.
 *
 * Export blanks `datatableId` (a datatable id names a table in ONE
 * organisation) and keeps `datatableKey`. Without this the importer got a step
 * that cannot run and does not say what it wanted — and because
 * `datatable.table_missing` blocks at the import route's activate-stage
 * validation, an automation with a datatable step could not be imported at all.
 *
 * Three rules, each of them the reason this is not just a lookup:
 *
 *  1. Only an EMPTY id is filled. A step that still carries an id is left
 *     exactly as it is: re-binding must never RE-POINT a bound step, or a
 *     hand-edited file could quietly redirect a write to a different table.
 *     The id stays authoritative at run time; the key is advisory and read
 *     only here.
 *  2. Exactly ONE match, or nothing. Keys are unique per scope, so two matches
 *     mean two tenancies (the organisation's table and the importer's own
 *     personal one) and there is no honest way to choose between them.
 *  3. `tables` is whatever the CALLER resolved for the importing scope, so a
 *     re-bind can never cross a scope boundary — this function has no way to
 *     reach a table the caller did not hand it.
 *
 * Every entry carries a rendered `message` because the two callers put warnings
 * in different envelopes (the import route returns finding objects, a Blueprint
 * install returns strings) and the sentence must not be written twice.
 *
 * Mutates `definition`.
 *
 * @param {object} definition
 * @param {Array<{id: string, key: string, name?: string}>} tables  tables the importer may use
 * @returns {{ relinked: number, entries: Array<object> }}
 */
function rebindDatatables(definition, tables) {
    const entries = [];
    if (!isObject(definition)) return { relinked: 0, entries };

    const byKey = new Map();
    for (const t of (Array.isArray(tables) ? tables : [])) {
        if (!isObject(t) || typeof t.key !== 'string' || !t.key || typeof t.id !== 'string' || !t.id) continue;
        if (!byKey.has(t.key)) byKey.set(t.key, []);
        byKey.get(t.key).push(t);
    }

    let relinked = 0;
    walkAllSteps(definition, (step, layerKey, isTrigger) => {
        if (isTrigger || step.type !== 'datatable') return;
        if (typeof step.datatableId === 'string' && step.datatableId) return;   // rule 1
        const key = typeof step.datatableKey === 'string' ? step.datatableKey.trim() : '';
        const where = layerKey ? ` (flowlet "${layerKey}")` : '';
        const stepId = typeof step.id === 'string' && step.id ? step.id : '(no id)';
        if (!key) {
            entries.push({
                stepId: step.id || null, layerKey: layerKey || null, datatableKey: null,
                datatableId: null, matches: 0,
                message: `Step "${stepId}"${where} has no datatable and does not say which one it wants. Open it and pick a table.`,
            });
            return;
        }
        const matches = byKey.get(key) || [];
        if (matches.length === 1) {
            step.datatableId = matches[0].id;
            relinked++;
            entries.push({
                stepId: step.id || null, layerKey: layerKey || null, datatableKey: key,
                datatableId: matches[0].id, matches: 1,
                // Named, never silent: the key travelled with the file, so the
                // table it lands on is the importer's, chosen by a slug the
                // author picked. Worth a look before the automation goes live.
                message: `Step "${stepId}"${where} was linked to your table "${matches[0].name || key}" (key "${key}"). Check it is the right one before activating.`,
            });
            return;
        }
        entries.push({
            stepId: step.id || null, layerKey: layerKey || null, datatableKey: key,
            datatableId: null, matches: matches.length,
            message: matches.length === 0
                ? `Step "${stepId}"${where} wants a datatable with the key "${key}", and there is no such table here. Create one or pick a different table.`
                : `Step "${stepId}"${where} wants a datatable with the key "${key}", and ${matches.length} of your tables use it. Open the step and pick the right one.`,
        });
    });
    return { relinked, entries };
}

// ── Re-keying ───────────────────────────────────────────
//
// A step id hides in more places than any list of fields can keep up with:
// edges and trigger ids, binding wrappers anywhere ({kind:'ref'|'template'|
// 'expr'}), bare reference paths (forEach.overRef on ANY step, sourceRef,
// arrayRef, datetime inputs, data_extraction.source), bare templates
// (notification and approval texts, HTTP url/headers/body, ai_step.prompt,
// document and slide texts, form pages, approval details/fields/stages, a
// datatable cursor, …) and bare expressions (condition/switch/filter `expr`,
// switch cases, approval stage `when`).
//
// Per-type tables of those fields drifted from what the runner reads — an
// imported or installed automation kept the ORIGINAL ids on per-item steps,
// parse/guard sources, HTTP requests and prompts, and landed broken. So the
// rewrite is a walk over EVERY value of a step, and each string is read for
// what it is (stepIdRewrite.js): a template if it has placeholders, a whole
// reference path, or an expression. Prose matches none of those and is left
// alone. Only the step-id token changes; everything else stays byte for byte.
//
// What is deliberately NOT rewritten:
//   - `{kind:'literal'}` values: they ship verbatim at run time;
//   - a code step's `code`: JavaScript, which reads its `inputs`, never `steps`;
//   - pins (captured data) and the step's own id/type/layerKey/position;
//   - data_extraction.instructions: guidance for the model, never interpolated;
//   - parse_json's `fields` and `itemsRef`: paths RELATIVE to the parsed value,
//     where `steps` would be a key of that value, not the run's steps;
//   - a note's `text`: an annotation for people, read by nothing.

const { rewriteRefPath, rewriteTemplate, rewriteExpr, rewriteAnyString } = require('./stepIdRewrite');

const BINDING_KINDS = new Set(['literal', 'ref', 'template', 'expr']);
/** Keys whose string value is an expression even when it does not parse yet (half-typed). */
const EXPR_KEYS = new Set(['expr', 'when']);
const NEVER_REWRITTEN = new Set(['id', 'type', 'layerKey', 'position', 'code', ...PIN_FIELDS]);
const VERBATIM_FIELDS = {
    data_extraction: new Set(['instructions']),
    parse_json: new Set(['fields', 'itemsRef']),
    // A canvas annotation: text for people, read by nothing.
    note: new Set(['text']),
};

/** Rewrite one binding wrapper in place (literal: untouched). */
function rewriteBinding(b, map) {
    if (b.kind === 'ref' && typeof b.path === 'string') b.path = rewriteRefPath(b.path, map);
    else if (b.kind === 'template' && typeof b.value === 'string') b.value = rewriteTemplate(b.value, map);
    else if (b.kind === 'expr' && typeof b.value === 'string') b.value = rewriteExpr(b.value, map);
}

/**
 * Rewrite step ids in any value: strings by what they are, binding wrappers
 * by their kind, objects and lists all the way down. Returns the new value
 * (strings are immutable); objects are rewritten in place.
 */
function rewriteValue(value, map, key) {
    if (typeof value === 'string') return EXPR_KEYS.has(key) ? rewriteExpr(value, map) : rewriteAnyString(value, map);
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) value[i] = rewriteValue(value[i], map, key);
        return value;
    }
    if (!isObject(value)) return value;
    if (typeof value.kind === 'string' && BINDING_KINDS.has(value.kind)) {
        rewriteBinding(value, map);
        return value;
    }
    for (const k of Object.keys(value)) value[k] = rewriteValue(value[k], map, k);
    return value;
}

/**
 * Fresh id preserving the old id's readable prefix (`ai_3f2a1b` → `ai_…`,
 * builderTools newId idiom) so re-keyed graphs stay debuggable.
 */
function freshId(oldId, used) {
    const m = /^([A-Za-z][A-Za-z0-9]*)_/.exec(String(oldId));
    const prefix = m ? m[1]
        : (/^[A-Za-z][A-Za-z0-9]{0,7}$/.test(String(oldId)) ? String(oldId) : 's');
    let id;
    do { id = `${prefix}_${crypto.randomBytes(3).toString('hex')}`; } while (used.has(id));
    used.add(id);
    return id;
}

/** Rename one step (and its nested loop/parallel children) + rewrite every reference it carries. */
function rekeyStep(step, map) {
    if (typeof step.id === 'string' && Object.prototype.hasOwnProperty.call(map, step.id)) step.id = map[step.id];
    const verbatim = VERBATIM_FIELDS[step.type];
    for (const k of Object.keys(step)) {
        if (NEVER_REWRITTEN.has(k) || (verbatim && verbatim.has(k))) continue;
        // Nested steps are steps: renamed and walked by the same rules.
        // (`body` is nested steps only on a loop — a notification's body is a
        // template and goes through the generic walk.)
        if (k === 'body' && step.type === 'loop' && Array.isArray(step.body)) {
            for (const child of step.body) { if (isObject(child)) rekeyStep(child, map); }
            continue;
        }
        if (k === 'branches' && step.type === 'parallel' && Array.isArray(step.branches)) {
            for (const branch of step.branches) {
                if (!Array.isArray(branch)) continue;
                for (const child of branch) { if (isObject(child)) rekeyStep(child, map); }
            }
            continue;
        }
        step[k] = rewriteValue(step[k], map, k);
    }
}

/**
 * Re-key ONE graph (root document or a layer mini-definition) in place.
 * Returns the oldId → newId map for the graph.
 */
function rekeyGraph(graph) {
    if (!isObject(graph)) return {};
    const oldIds = [];
    // Every node the graph addresses by id: the primary trigger, each ADDITIONAL
    // trigger, and every step (nested ones included). The `triggers[]` array was
    // missing here — an imported automation kept its extra entry points' original
    // ids, which is precisely the collision re-keying exists to prevent, and the
    // edges out of them were rewritten while the trigger they left was not.
    walkTriggers(graph, null, (t) => {
        if (typeof t.id === 'string' && t.id) oldIds.push(t.id);
    });
    walkSteps(graph.steps, (s) => {
        if (typeof s.id === 'string' && s.id) oldIds.push(s.id);
    });
    // Seed `used` with the old ids so a fresh id can never alias a
    // not-yet-renamed step mid-rewrite.
    const used = new Set(oldIds);
    const map = {};
    // Own keys only: a step called `constructor` must not find Object's.
    const has = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(map, id);
    for (const oldId of oldIds) {
        if (!has(oldId)) map[oldId] = freshId(oldId, used);
    }

    walkTriggers(graph, null, (t) => {
        if (has(t.id)) t.id = map[t.id];
    });
    if (Array.isArray(graph.steps)) {
        for (const s of graph.steps) { if (isObject(s)) rekeyStep(s, map); }
    }
    if (Array.isArray(graph.edges)) {
        for (const e of graph.edges) {
            if (!isObject(e)) continue;
            if (has(e.from)) e.from = map[e.from];
            if (has(e.to)) e.to = map[e.to];
        }
    }
    // `vars` may carry binding wrappers referencing steps.
    if (isObject(graph.vars)) rewriteValue(graph.vars, map, 'vars');
    return map;
}

/**
 * Re-key a whole definition: fresh step ids for the root graph AND each
 * inline layer, each under its OWN rename map (a binding inside a layer
 * references same-layer ids, never root ids). Layer keys and
 * call_layer.layerKey references are left untouched.
 *
 * @returns {{ definition: object, renameMap: { root: object, layers: object } }}
 */
function rekeyDefinition(def) {
    const definition = deepClone(isObject(def) ? def : {});
    const renameMap = { root: rekeyGraph(definition), layers: {} };
    if (isObject(definition.layers)) {
        for (const [key, layer] of Object.entries(definition.layers)) {
            if (isObject(layer)) renameMap.layers[key] = rekeyGraph(layer);
        }
    }
    return { definition, renameMap };
}

module.exports = { stripAppRefs,
    EXPORT_SUPPORTED_VERSIONS,
    EXPORT_FORMAT,
    EXPORT_SCHEMA_VERSION,
    buildExport,
    sanitizeImport,
    rebindDatatables,
    rekeyDefinition,
    // Step walking — shared with the Solution dependency graph so "how steps
    // nest" and "what a definition is made of" are each defined once.
    walkSteps,
    walkAllSteps,
    // Pin bookkeeping — what a pin is made of, and which nodes hold one. The
    // activation gate reads these so "what export strips" and "what activation
    // warns about" are the same definition of a pin.
    PIN_FIELDS,
    collectPinnedNodes,
};
