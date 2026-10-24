/**
 * What changed between two versions of a Blueprint — "What changed".
 *
 * NOT to be confused with core/releaseNotesDrafter.js and stores/releaseNotesStore.js:
 * those two are about the releases of the PRODUCT (build, git range, changelog).
 * This is about the release of one Solution: manifest v(n-1) beside manifest v(n).
 *
 * ── Two layers, and the distinction between them is the whole point ───────
 *
 * 1. THE BOOLEAN DIFF is exact and always available. Per entity `diffEntities` compares the hash of
 *    the same `hashDefinition` that the upgrade uses (appStudio/templateUpgrade.js) — one hasher in this
 *    product, because jsonb does not keep key order and a second hasher would sooner or later call an
 *    unchanged entity changed. This layer makes NO model call, does not touch the network and cannot fall over.
 *
 * 2. THE `text` is a fast-tier one-line summary per CHANGED entity. That is the semantic diff in plain
 *    language, and it is the only layer that depends on a model.
 *
 * Note which question layer 1 answers. The upgrade compares the manifest against the LIVE entity ("has the
 * recipient edited this?"). Here we compare manifest against manifest ("what did the MAKER change?").
 * Same hasher, different question — and that is why this diff ALSO works for datatables and knowledge bases,
 * which the upgrade cannot compare because there is no live payload for them.
 *
 * ── The model call may never throw and never hold up the publication ─────
 *
 * If it falls over — no provider, no model configured, a time-out, a refusal, unparseable arguments — then no
 * invented sentence appears but NO sentence: `text` stays null. The difference from "nothing has changed" lies
 * in `change`, which is exact: `change: 'changed'` with `text: null` means "we could not write it down",
 * `change: 'unchanged'` means "no news". Confusing those two is the difference between no news and no words;
 * `summaryMissing()` is the only place where that question should be answered.
 *
 * The two layers can also be called separately. `diffEntities` is synchronous and pure: a caller that wants to
 * publish first and enrich afterwards writes those notes away and runs `describeChanges` afterwards.
 *
 * ── The seam with the release table ──────────────────────────────────────
 *
 * The real shape of a note is the LIST per entity. `publishRelease` (stores/blueprintStore.js), however, takes a
 * flat OBJECT — the column is `notes JSONB NOT NULL DEFAULT '{}'` and an array is refused — and caps the whole
 * at 64 KB. `releaseNotesPayload()` is that one translation, in one place, including the shrinking that prevents a
 * Solution with hundreds of entities from having its own publication fail on a note.
 *
 * ── PRIVACY: what DOES go to the model ───────────────────────────────────
 *
 * The JSON diff of an entity may contain customer data — an example in a prompt, an e-mail address in an automation
 * step, a table row that stayed as a default value. Sending the whole diff is therefore not an option.
 *
 * What leaves is the SHAPE of the change, never the CONTENT:
 *
 *   • the kind of entity (`automation`, `app`, …) — product vocabulary;
 *   • a list of facts `{ path, change, count?, value? }`, where `path` is a KEY PATH
 *     (`definition.steps[]`) and therefore schema, not data;
 *   • a `value` exclusively on the paths in VALUE_PATHS, each of which is a CLOSED vocabulary of the product
 *     itself (a step type, a column type), and then only if the value looks like a token (TOKEN_RE) —
 *     a second slot in case free text ever lands on such a path.
 *
 * WHOSE MODEL. The tier resolution always receives `userId` (and `userOrgId` if the project has one). Without
 * `userId` NO call departs: a resolution without context falls back to the global fast tier, and then the shape
 * of someone else's Solution would go to the model of the instance rather than to the model that the workspace
 * chose — unknown should narrow, not widen.
 *
 * Which fields are looked at at all is set out in FIELD_ALLOW: an EXPLICIT allow-list per kind, not a deny-list.
 * A field that is added to the manifest next year therefore does not reach the model by itself — it DOES count
 * in the boolean diff, because that covers the whole entity.
 *
 * EXCLUDED, and why:
 *   • EVERY leaf value outside VALUE_PATHS. That is where the customer text lives: prompt examples, e-mail texts,
 *     column names, the HTML of a page, default values.
 *   • The NAME of the entity. That is already in the note row and is shown by the screen itself, so the model does
 *     not need it — and an automation may be named after a customer ("Reminder Van Dijk BV").
 *   • `ref` and every other internal handle: useless for a sentence.
 *   • `scheduleCron` as a VALUE. A cron is not personal data, but letting it through would require TOKEN_RE to allow
 *     spaces, and that makes the second slot blunt for every other permitted path. "The schedule has changed" is enough.
 *   • The model id of an agent. "A different model was chosen" is the fact; the brand name adds nothing worth looking at.
 *   • Anything beyond MAX_DEPTH levels deep, and object keys that do not read as identifiers (KEY_RE) — that is where
 *     keys invented by users live.
 *   • Entities that the new version NO LONGER contains. The notes block is the table of contents of the new version,
 *     and the three states are added/changed/unchanged; an installation moreover never deletes anything (see upgrade.js),
 *     so "removed" would promise something that does not happen.
 */

'use strict';
const log = require('../../telemetry/log');

/** How many characters a note line may have at most. One line, not a paragraph. */
const MAX_TEXT_CHARS = 160;
/** Zoveel entiteiten krijgen hooguit een modelaanroep. De rest houdt text null. */
const MAX_SUMMARIES = 25;
/** One line is not worth the wait. */
const TIMEOUT_MS = 15_000;
/** Totale tijd die het tekstlaagje mag kosten; daarna blijft de rest zonder zin. */
const DEADLINE_MS = 45_000;
/** Hoeveel aanroepen tegelijk lopen. */
const CONCURRENCY = 3;
/** This many facts go along at most. A wall of paths is not read by a model. */
const MAX_FACTS = 24;
/** This deep an object is inspected; deeper down are the invented keys. */
const MAX_DEPTH = 4;
/** Hard upper bound on the JSON that becomes the user message. */
const MAX_PAYLOAD_CHARS = 4000;
/** Lengtegrens op de naam die in de note-rij belandt. */
const MAX_NAME_CHARS = 120;
/**
 * What the envelope must stay below.
 *
 * Kept in step by hand with `blueprintStore.MAX_NOTES_BYTES`, because calling the store here would open a pool on require.
 * Exported so that the drift test in stores/blueprintStore.releases.test.js can compare the two: should the limit in the
 * store ever drop below this value, then `normalizeNotes` would throw and a PUBLICATION would be refused on account of a
 * note — precisely what this component must never cause.
 */
const MAX_NOTES_ENVELOPE_BYTES = 64 * 1024;

/** Manifest-sleutel (meervoud) → het enkelvoudige kind-vocabulaire van de stamps/plan. */
const KIND_OF = Object.freeze({
    automations: 'automation',
    apps: 'app',
    webpages: 'webpage',
    datatables: 'datatable',
    agents: 'agent',
    knowledgeBases: 'knowledge_base',
});

/**
 * The fields per kind of which a CHANGE may be described.
 *
 * Allow-list, not deny-list: a field that is added to the manifest next year does not reach the model until someone
 * writes it down here. That a field appears here does not, incidentally, mean that its CONTENT leaves — only the path.
 * Values leave exclusively via VALUE_PATHS.
 */
const FIELD_ALLOW = Object.freeze({
    automation: Object.freeze(['kind', 'title', 'description', 'triggerType', 'scheduleCron', 'scheduleTz', 'definition']),
    app: Object.freeze(['name', 'description', 'icon', 'accentColor', 'definition', 'seedTables']),
    webpage: Object.freeze(['name', 'description', 'instructions', 'icon', 'accentColor', 'tagline', 'files', 'bridgeGrants']),
    datatable: Object.freeze(['key', 'name', 'description', 'rowScope', 'retentionDays', 'retentionField', 'subjectColumn', 'columns']),
    agent: Object.freeze(['name', 'description', 'systemPrompt', 'model', 'starterPrompts', 'threadsEnabled', 'copyEnabled', 'workspaceEnabled', 'config']),
    knowledge_base: Object.freeze(['name', 'description', 'icon', 'usageContexts']),
});

/**
 * The paths whose VALUE may go along. Each one a closed vocabulary of the product itself: a step type comes from the
 * step catalogue, a column type from a fixed list, a rowScope is 'own' or 'all'. Free text does not belong here, and
 * cannot land here by accident: TOKEN_RE is the second slot on every value that passes this.
 */
const VALUE_PATHS = Object.freeze([
    'kind',
    'triggerType',
    'scheduleTz',
    'rowScope',
    'threadsEnabled',
    'copyEnabled',
    'workspaceEnabled',
    'config.memoryEnabled',
    'definition.trigger.type',
    'definition.steps[].type',
    'columns[].type',
    'usageContexts[]',
]);
/** The same list as a Set. Separately, because a frozen Set is not frozen IN ITS CONTENTS: the freeze slot sits on the own
 *  properties, not on the content of a Set — and an allow-list that can be quietly added to is no allow-list. */
const VALUE_PATH_SET = new Set(VALUE_PATHS);

/** An object key that reads as schema. Everything else becomes `*` in the path. */
const KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;
/** A value that reads as an enum token. No spaces: free text falls away. */
const TOKEN_RE = /^[A-Za-z0-9_.:/-]{1,40}$/;

const TOOL = Object.freeze({
    type: 'function',
    function: {
        name: 'record_change_summary',
        description: 'Record, in one short line, what changed in this part of the Solution.',
        parameters: {
            type: 'object',
            properties: {
                summary: {
                    type: 'string',
                    description: `One line of at most ${MAX_TEXT_CHARS} characters, saying what changed. No name, no quotes, no bullet list.`,
                },
            },
            required: ['summary'],
        },
    },
});

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** Dezelfde hasher als de upgrade. Laat geladen, net als daar. */
function hashOf(payload) {
    const { hashDefinition } = require('../../appStudio/templateUpgrade');
    return hashDefinition(payload);
}

// ── Laag 1: de boolean diff ────────────────────────────────────────────────

/** The name that goes into the note row. Automations are called `title`, tables also have a `key`. */
function nameOf(entity) {
    const raw = [entity?.name, entity?.title, entity?.key, entity?.ref]
        .find(v => typeof v === 'string' && v.trim());
    return (raw || '').trim().slice(0, MAX_NAME_CHARS);
}

function entityList(manifest, pluralKind) {
    const list = manifest?.solution?.entities?.[pluralKind];
    return Array.isArray(list) ? list.filter(isObject) : [];
}

/**
 * The boolean diff, per entity, without a single model call.
 *
 * Matched on `ref`, because that is the only identity notion a manifest has: real ids deliberately do not travel along
 * (see capture.js). Refs are POSITIONAL, so a maker who reorders entities sees a shift as "changed". That is the safe side of
 * the error: this diff may call something changed wrongly, but never call it unchanged wrongly.
 *
 * @returns {Array<{kind:string, entityId:string, name:string, change:'added'|'changed'|'unchanged', text:null}>}
 */
function diffEntities({ previousManifest = null, manifest } = {}) {
    const notes = [];
    for (const [plural, kind] of Object.entries(KIND_OF)) {
        const previousByRef = new Map(
            entityList(previousManifest, plural)
                .filter(e => typeof e.ref === 'string' && e.ref)
                .map(e => [e.ref, e]),
        );
        for (const entity of entityList(manifest, plural)) {
            const ref = typeof entity.ref === 'string' ? entity.ref : '';
            const before = ref ? previousByRef.get(ref) : undefined;
            let change = 'added';
            if (before !== undefined) change = hashOf(before) === hashOf(entity) ? 'unchanged' : 'changed';
            notes.push({
                kind,
                // The bundle-local ref, NEVER a real id: a manifest carries none,
                // and this field is called `entityId` because it is the identity
                // of the entity WITHIN the release.
                entityId: ref,
                name: nameOf(entity),
                change,
                text: null,
            });
        }
    }
    return notes;
}

/** Is this line a missing summary, or simply no news? */
function summaryMissing(note) {
    return !!note && note.change === 'changed' && !note.text;
}

// ── Laag 2a: wat het model te zien krijgt ──────────────────────────────────

function safeKey(key) {
    return KEY_RE.test(key) ? key : '*';
}

/** A value may only go along on a permitted path, and only as a token. */
function safeValue(value, path) {
    if (!VALUE_PATH_SET.has(path)) return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string' && TOKEN_RE.test(value)) return value;
    return undefined;
}

function sameJson(a, b) {
    if (a === undefined && b === undefined) return true;
    if (a === undefined || b === undefined) return false;
    return hashOf(a) === hashOf(b);
}

function pushFact(facts, fact) {
    if (facts.length >= MAX_FACTS) return;
    const key = JSON.stringify(fact);
    if (facts.some(f => JSON.stringify(f) === key)) return;
    facts.push(fact);
}

/** Multiset-telling van de waarden op één toegelaten pad binnen een array. */
function valueCounts(list, key, path) {
    const counts = new Map();
    for (const item of (Array.isArray(list) ? list : [])) {
        const raw = key === null ? item : (isObject(item) ? item[key] : undefined);
        const value = safeValue(raw, path);
        if (value === undefined) continue;
        counts.set(value, (counts.get(value) || 0) + 1);
    }
    return counts;
}

/**
 * Arrays are compared as a MULTISET, not element by element.
 *
 * Inserting one step at the front would otherwise shift every following element and produce a wall of "changed" where nothing
 * has changed. A count plus the permitted values ("two steps added: send_email, condition") says what a release note needs, and
 * cannot describe an index shift as content by mistake.
 */
function arrayFacts(before, after, path, facts) {
    const arrayPath = `${path}[]`;
    const start = facts.length;

    if (before.length !== after.length) {
        const delta = after.length - before.length;
        pushFact(facts, {
            path: arrayPath,
            change: delta > 0 ? 'added' : 'removed',
            count: Math.abs(delta),
        });
    }

    // De toegelaten waardepaden die binnen déze array liggen: `x[]` voor een
    // array van scalars, `x[].type` voor een array van objecten.
    for (const valuePath of VALUE_PATH_SET) {
        let key;
        if (valuePath === arrayPath) key = null;
        else if (valuePath.startsWith(`${arrayPath}.`) && !valuePath.slice(arrayPath.length + 1).includes('.')) key = valuePath.slice(arrayPath.length + 1);
        else continue;

        const beforeCounts = valueCounts(before, key, valuePath);
        const afterCounts = valueCounts(after, key, valuePath);
        for (const value of new Set([...beforeCounts.keys(), ...afterCounts.keys()])) {
            const delta = (afterCounts.get(value) || 0) - (beforeCounts.get(value) || 0);
            if (delta === 0) continue;
            pushFact(facts, { path: valuePath, change: delta > 0 ? 'added' : 'removed', count: Math.abs(delta), value });
        }
    }

    if (facts.length === start) pushFact(facts, { path: arrayPath, change: 'changed' });
}

function walk(before, after, path, depth, facts) {
    if (facts.length >= MAX_FACTS) return;
    if (sameJson(before, after)) return;

    if (before === undefined || after === undefined) {
        const present = before === undefined ? after : before;
        const fact = { path, change: before === undefined ? 'added' : 'removed' };
        const value = safeValue(present, path);
        if (value !== undefined) fact.value = value;
        pushFact(facts, fact);
        return;
    }

    if (Array.isArray(before) && Array.isArray(after)) {
        arrayFacts(before, after, path, facts);
        return;
    }

    if (isObject(before) && isObject(after)) {
        if (depth >= MAX_DEPTH) { pushFact(facts, { path, change: 'changed' }); return; }
        const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
        for (const key of keys) walk(before[key], after[key], `${path}.${safeKey(key)}`, depth + 1, facts);
        return;
    }

    const fact = { path, change: 'changed' };
    const value = safeValue(after, path);
    if (value !== undefined) fact.value = value;
    pushFact(facts, fact);
}

/**
 * Everything about one changed entity that may go to the model — or null if nothing describable changed.
 *
 * Built from FIELD_ALLOW and not by removing keys from the entity: a field that is added next year would otherwise leak along by itself.
 */
function modelPayload(kind, before, after) {
    const allowed = FIELD_ALLOW[kind];
    if (!allowed) return null;
    const facts = [];
    for (const field of allowed) {
        walk(
            isObject(before) ? before[field] : undefined,
            isObject(after) ? after[field] : undefined,
            field, 1, facts,
        );
    }
    if (!facts.length) return null;
    facts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { kind, changes: facts };
}

// ── Laag 2b: de zin, die nooit gooit ───────────────────────────────────────

/**
 * The only bound on a call that NEVER settles.
 *
 * A half-open socket gives neither an answer nor an error; without this race `summariseChange` would hang forever, and — once a route awaits it —
 * the publication request itself. The deadline in `describeChanges` does not rescue that: it is checked BEFORE the await, not during.
 *
 * Exported for precisely that reason, to be testable: a promise that never settles should here come out as a rejection within `ms`, and the timer is
 * cleared as soon as the promise does settle (otherwise a successful call keeps the event loop open for `ms` — visible in a test run without
 * --test-force-exit).
 */
function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

/** Model output is untrusted: type, length and emptiness are enforced here. */
function normalise(structured) {
    if (!isObject(structured)) return null;
    const summary = typeof structured.summary === 'string' ? structured.summary.trim() : '';
    if (!summary) return null;
    return summary.slice(0, MAX_TEXT_CHARS);
}

function systemPrompt(language) {
    return [
        'You write one-line change notes for a packaged Solution, for the people who will install the new version.',
        `Answer in ${language}.`,
        'You are given a STRUCTURAL list of what changed: which fields changed, how many items were added or removed, and — only for a few closed vocabularies — the value.',
        'You are NOT given the content. Never invent a value, a name, an address, a number or a piece of text you cannot see in the list.',
        `Write at most ${MAX_TEXT_CHARS} characters, one line, no bullet list, no quotes.`,
        'Do not name the item — the screen shows its name next to your line. Describe only what changed about it.',
        'If the list is vague, be vague and short ("the steps changed") rather than specific and wrong.',
    ].join(' ');
}

/**
 * One line about one changed entity — or null.
 *
 * NEVER THROWS. No provider, no configured model, an unreadable config, a time-out, a refused tool, unparseable arguments: all null.
 * Null means "we could not write it down", never "nothing has changed" — `change` remains the only source for that.
 */
async function summariseChange({ kind, before, after, language = 'English', userOrgId = null, userId = null, modelId = undefined, timeoutMs = TIMEOUT_MS, deps = {} } = {}) {
    try {
        const payload = modelPayload(kind, before, after);
        if (!payload) return null;

        const llmClient = deps.llmClient || require('../../core/llm/llmClient');
        let model = modelId;
        if (model === undefined) {
            // UNKNOWN NARROWS. Without `userId` there is nothing to fetch: the org override hangs on `userOrgId` and the EU mode on
            // the Privacy Shield of the user (modelResolver.isEUModeActive). A resolution lacking both falls back to the GLOBAL fast tier —
            // then the shape of someone else's Solution would go to the model of the instance rather than to the model that this workspace
            // chose. No context is therefore no sentence, never a broader choice. (`userOrgId` may well be null: a personal project
            // has no organisation, and the user then decides.)
            if (!userId) return null;
            const resolve = deps.resolveModelForTierName
                || require('../../core/llm/modelResolver').resolveModelForTierName;
            // `fallback` remains opt-in and is not given here —
            // nobody-has-one-configured is a real answer and means: no sentence.
            model = await resolve('fast', { userOrgId, userId });
        }
        if (!model) return null;

        const body = JSON.stringify(payload).slice(0, MAX_PAYLOAD_CHARS);
        const result = await withTimeout(
            llmClient.chatForcedTool(model, [
                { role: 'system', content: systemPrompt(language) },
                { role: 'user', content: body },
            ], TOOL, { maxTokens: 200, temperature: 0 }),
            timeoutMs,
            'release note',
        );
        return normalise(result?.structured);
    } catch (e) {
        // Silent at warn level: on an installation without a provider this would
        // otherwise fire per entity on every publication.
        log.warn('[Blueprint] change summary unavailable:', e.message);
        return null;
    }
}

/**
 * Vul `text` op de gewijzigde regels. Muteert de meegegeven notes en geeft ze
 * terug. Gooit niet, en houdt niets tegen: wat na de deadline of boven
 * MAX_SUMMARIES komt houdt gewoon `text: null`.
 */
async function describeChanges(notes, { previousManifest = null, manifest, language = 'English', userOrgId = null, userId = null, timeoutMs = TIMEOUT_MS, deps = {}, deadlineMs = DEADLINE_MS, now = () => Date.now() } = {}) {
    const list = Array.isArray(notes) ? notes : [];
    const targets = list.filter(n => n && n.change === 'changed').slice(0, MAX_SUMMARIES);
    if (!targets.length) return list;
    // The same narrowing as in `summariseChange`, here before the resolution so that
    // no call departs without user context.
    if (!userId) return list;

    const byRef = new Map();
    for (const [plural, kind] of Object.entries(KIND_OF)) {
        for (const entity of entityList(previousManifest, plural)) byRef.set(`prev:${kind}:${entity.ref}`, entity);
        for (const entity of entityList(manifest, plural)) byRef.set(`next:${kind}:${entity.ref}`, entity);
    }

    // One model resolution for the whole round: it costs a config read and the answer
    // is the same for every entity. Should it throw, the whole text layer falls silent — exactly as one failed call does
    // for a single line — and the notes go back unchanged.
    let modelId = null;
    try {
        const resolve = deps.resolveModelForTierName
            || require('../../core/llm/modelResolver').resolveModelForTierName;
        modelId = await resolve('fast', { userOrgId, userId });
    } catch (e) {
        log.warn('[Blueprint] no model for change summaries:', e.message);
        return list;
    }
    if (!modelId) return list;

    const deadline = now() + deadlineMs;
    let cursor = 0;
    const worker = async () => {
        for (;;) {
            const index = cursor++;
            if (index >= targets.length) return;
            if (now() >= deadline) return;
            const note = targets[index];
            note.text = await summariseChange({
                kind: note.kind,
                before: byRef.get(`prev:${note.kind}:${note.entityId}`),
                after: byRef.get(`next:${note.kind}:${note.entityId}`),
                language, userOrgId, userId, modelId, timeoutMs, deps,
            });
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
    return list;
}

/**
 * The notes as `blueprintStore.publishRelease` takes them.
 *
 * That requires a flat OBJECT (`notes JSONB NOT NULL DEFAULT '{}'::jsonb`; an array is refused with "Release notes must be an object") and caps the
 * whole at MAX_NOTES_BYTES — 64 KB. The real shape of a note is the list per entity, so that sits here in an envelope under `entities`.
 *
 * AND IT ALWAYS FITS. A Solution with hundreds of entities would exceed those 64 KB, and then publishRelease would throw — that is holding back the
 * publication on account of a note, precisely what this component must never do. So it shrinks from least to most valuable:
 *   1. the SENTENCES, because that is the enrichment; the exact diff is the core;
 *   2. the UNCHANGED lines, because that is the least news;
 *   3. and otherwise the tail of the list.
 * What dropped out is recorded as `omitted` in the envelope, so that the screen can say "n parts are not included" instead of suggesting
 * that they are not there.
 *
 * `maxBytes` has the same default as `blueprintStore.MAX_NOTES_BYTES`; the store itself is not called here, because that opens a pool on require.
 */
function releaseNotesPayload(notes, { maxBytes = MAX_NOTES_ENVELOPE_BYTES } = {}) {
    const rows = (Array.isArray(notes) ? notes : []).filter(n => n && typeof n === 'object');
    const fits = (payload) => Buffer.byteLength(JSON.stringify(payload), 'utf8') <= maxBytes;

    let payload = { entities: rows, omitted: 0, textsDropped: false };
    if (fits(payload)) return payload;

    const stripped = rows.map(n => ({ ...n, text: null }));
    payload = { entities: stripped, omitted: 0, textsDropped: true };
    if (fits(payload)) return payload;

    let list = stripped.filter(n => n.change !== 'unchanged');
    for (;;) {
        payload = { entities: list, omitted: rows.length - list.length, textsDropped: true };
        if (fits(payload) || !list.length) return payload;
        list = list.slice(0, Math.floor(list.length / 2));
    }
}

/**
 * The notes for one release: the exact boolean diff, with a sentence on the changed lines where that succeeded.
 *
 * Does not throw. Should the text layer fall over in its entirety, the exact added/changed/unchanged are still there — publishing can always go ahead.
 */
async function buildReleaseNotes({ previousManifest = null, manifest, language = 'English', userOrgId = null, userId = null, timeoutMs = TIMEOUT_MS, deps = {}, deadlineMs = DEADLINE_MS, now = () => Date.now() } = {}) {
    const notes = diffEntities({ previousManifest, manifest });
    try {
        await describeChanges(notes, { previousManifest, manifest, language, userOrgId, userId, timeoutMs, deps, deadlineMs, now });
    } catch (e) {
        log.warn('[Blueprint] change summaries unavailable:', e.message);
    }
    return notes;
}

module.exports = {
    buildReleaseNotes,
    releaseNotesPayload,
    diffEntities,
    describeChanges,
    summariseChange,
    summaryMissing,
    modelPayload,
    normalise,
    withTimeout,
    KIND_OF,
    FIELD_ALLOW,
    VALUE_PATHS,
    TOOL,
    MAX_NOTES_ENVELOPE_BYTES,
    MAX_TEXT_CHARS,
    MAX_SUMMARIES,
    MAX_FACTS,
    MAX_DEPTH,
    TIMEOUT_MS,
    DEADLINE_MS,
};
