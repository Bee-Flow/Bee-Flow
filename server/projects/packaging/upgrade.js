/**
 * Upgrade an installed Solution to a newer Blueprint.
 *
 * ── Additive only, and that is a safety property ───────────────────────────
 *
 * An entity nobody has touched is replaced. An entity somebody HAS touched is
 * left exactly as it is and named in the report. An entity the new Blueprint
 * adds is created. NOTHING IS EVER DELETED — not an entity the new version
 * dropped, not one somebody added by hand.
 *
 * That is the same fail-safe posture templateInstall takes with
 * seedMode 'missing-tables-only', and for the same reason: an upgrade must not
 * be able to destroy work. Someone can always delete what they no longer want;
 * nobody can un-delete an automation an upgrade decided was obsolete.
 *
 * ── Per entity, never per project ──────────────────────────────────────────
 *
 * Pristine-ness is decided one entity at a time against the hash recorded when
 * it was installed. A project-level hash would mean one hand-edited app freezes
 * the whole Solution — the upgrade would refuse everything because of a change
 * to something unrelated.
 *
 * ── One hasher ─────────────────────────────────────────────────────────────
 *
 * hashDefinition and stableStringify are App Studio's, reused unchanged. jsonb
 * does not preserve key order, so a second hasher would eventually call an
 * untouched entity dirty and skip an upgrade nobody declined.
 */

'use strict';

const { sanitizeManifest } = require('./manifest');
const { HttpError } = require('../../core/http/errors');
const log = require('../../telemetry/log');

function hashOf(payload) {
    const { hashDefinition } = require('../../appStudio/templateUpgrade');
    return hashDefinition(payload);
}

/**
 * The kinds an upgrade may REPLACE, and the reason the other two are absent.
 *
 * A newer Blueprint replacing an automation, an app, a page or an agent rewrites a
 * DOCUMENT the recipient has not touched. Replacing a TABLE would rewrite a
 * schema that has rows under it — a column the new version dropped takes its
 * data with it — and replacing a KNOWLEDGE BASE would rename or re-scope a
 * base somebody has been filling since the day they installed it.
 *
 * Both therefore take part in an upgrade as ADD ONLY: a table or a base the new
 * version introduces is created, and one that is already there is left exactly
 * as it is and named in the report. That is the same fail-safe posture as the
 * rest of this module, applied where the stakes are highest — see the header.
 */
const REPLACEABLE_KINDS = new Set(['automation', 'app', 'webpage', 'agent']);

/** What an entity looks like NOW, in the same shape install hashed on arrival. */
async function currentPayload(kind, entityId) {
    if (kind === 'automation') {
        const row = await require('../../stores/automationStore').getAutomation(entityId);
        return row ? row.definition : null;
    }
    if (kind === 'app') {
        const row = await require('../../stores/studioAppStore').getStudioApp(entityId);
        return row ? row.definition : null;
    }
    if (kind === 'webpage') {
        const store = require('../../stores/webpageStore');
        const row = await store.getWebpageRaw(entityId);
        if (!row) return null;
        return await store.readAllSlots(row.userId, entityId);
    }
    if (kind === 'agent') {
        // `config` is what install hashed, and it is the whole of what a
        // Blueprint can change about an agent.
        const row = await require('../../stores/agentStore').getAgent(entityId);
        return row ? (row.config || {}) : null;
    }
    return null;
}

/** The entity lists a plan walks, paired with the kind each one carries. */
const PLAN_LISTS = (entities) => [
    ['automation', entities.automations],
    ['app', entities.apps],
    ['webpage', entities.webpages],
    ['agent', entities.agents],
    ['datatable', entities.datatables],
    ['knowledge_base', entities.knowledgeBases],
];

/**
 * Decide what an upgrade would do, without doing any of it.
 *
 * Separated from applying so the answer can be shown to somebody before they
 * commit to it — "3 will be updated, 1 you have edited will be left alone" is a
 * decision, and an upgrade that only tells you afterwards is not offering one.
 */
async function planUpgrade({ projectId, manifest } = {}) {
    const checked = sanitizeManifest(manifest);
    if (!checked.ok) return { ok: false, errors: checked.errors };

    const stamps = await require('../../stores/blueprintStore').listStamps(projectId);
    const entities = checked.manifest.solution.entities;
    const plan = { replace: [], skip: [], add: [], missing: [] };

    for (const [kind, list] of PLAN_LISTS(entities)) {
        for (const entity of (list || [])) {
            const stamp = stamps.get(entity.ref);
            if (!stamp) { plan.add.push({ ref: entity.ref, kind }); continue; }

            if (!REPLACEABLE_KINDS.has(kind)) {
                plan.skip.push({
                    ref: entity.ref, kind, entityId: stamp.entityId,
                    why: 'already installed, and an update never rewrites one — it holds live data',
                });
                continue;
            }

            // ONLEESBAAR IS GEEN VERWIJDERD, en dat verschil is hier duur.
            // `.catch(() => null)` maakte van een storefout (een DB-hik, een
            // lezer die gooit) precies hetzelfde antwoord als "bestaat niet
            // meer", en de client zet daar de stelligste zin van de dialoog bij:
            // "{n} thing you deleted is not brought back". De eigenaar kreeg dan
            // te horen dat hij iets had weggegooid dat er gewoon staat.
            //
            // Een mislukte lees gaat daarom naar `skip` met een `why` die het
            // woord "edited" NIET bevat. De client eist twee signalen voordat
            // hij "jij hebt dit aangepast" beweert (upgradeClient.planRows), dus
            // deze rij landt in "niet te bepalen" — de derde toestand die er al
            // was. Geen nieuwe groep, geen contractwijziging, en de veilige
            // kant: er wordt niets vervangen en niets beweerd.
            let now;
            try {
                now = await currentPayload(kind, stamp.entityId);
            } catch (err) {
                plan.skip.push({
                    ref: entity.ref, kind, entityId: stamp.entityId,
                    why: `could not be read, so it is left untouched: ${err.message}`,
                });
                continue;
            }
            if (now === null) {
                // Installed once, gone now. Re-adding it would resurrect
                // something somebody deleted on purpose, so it is reported
                // instead — deletion is a decision, not damage.
                plan.missing.push({ ref: entity.ref, kind, entityId: stamp.entityId });
                continue;
            }
            if (hashOf(now) === stamp.installHash) {
                plan.replace.push({ ref: entity.ref, kind, entityId: stamp.entityId });
            } else {
                plan.skip.push({ ref: entity.ref, kind, entityId: stamp.entityId, why: 'edited since it was installed' });
            }
        }
    }

    return { ok: true, plan, toVersion: checked.manifest.solution.version, manifest: checked.manifest };
}


/**
 * Is this Blueprint newer than what the project has?
 *
 * Equal versions are NOT an upgrade: re-applying the same version would replace
 * a pristine entity with an identical copy, which is churn, and would say
 * "updated 3 things" when it changed nothing.
 */
function isNewer({ installedVersion, blueprintVersion }) {
    return Number.isInteger(blueprintVersion) && blueprintVersion > (installedVersion || 0);
}

function clone(v) {
    try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v ?? null)); }
}

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// ── The step ids install chose (F10) ────────────────────────────────────────

/** A step id the rewrite below may write into a definition. */
const STEP_ID_RE = /^[A-Za-z_$][A-Za-z0-9_$-]{0,127}$/;
/** The characters an id is made of: a match next to one is part of a longer id. */
const ID_CHAR = 'A-Za-z0-9_$';
const MAX_REKEY_TRIES = 8;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Every graph of a rename map as [graphKey, map]; 'root' first, then `layer:<key>`. */
function graphsOf(renameMap) {
    const out = [['root', isPlainObject(renameMap?.root) ? renameMap.root : {}]];
    for (const [key, map] of Object.entries(isPlainObject(renameMap?.layers) ? renameMap.layers : {})) {
        out.push([`layer:${key}`, isPlainObject(map) ? map : {}]);
    }
    return out;
}

function storedGraph(stepIdMap, graphKey) {
    const map = graphKey === 'root' ? stepIdMap?.root : stepIdMap?.layers?.[graphKey.slice('layer:'.length)];
    return isPlainObject(map) ? map : {};
}

/**
 * Give a newer version of an automation the step ids its install chose.
 *
 * Install renames every step (rekeyDefinition) so two installs never share ids,
 * and records the rename map on the stamp. A newer Blueprint carries the
 * SOURCE ids again; written as they are, every webhook (`trigger_step_id`),
 * paused run and step reference that holds an installed id would point at a
 * step that no longer exists. So the newer definition is renamed with the SAME
 * map: a step that was there before gets the id it was installed under, and a
 * step the new version adds gets a fresh one, which joins the map.
 *
 * ── How, without a second renamer ──────────────────────────────────────────
 *
 * Renaming touches every surface a step id hides in (edges, triggers,
 * bindings, templates, expressions, form texts, document values, nested loop
 * and parallel steps, layers). automation/portability.rekeyDefinition knows
 * all of them and is the only code that should. It renames to random ids, so
 * the target ids are put in afterwards: every random id is a token nothing in
 * the input contained (checked, retried otherwise), and each occurrence of one
 * is replaced, as a whole identifier, by the id the map names. The result is
 * exactly rekeyDefinition's rewrite with a chosen map instead of a random one.
 *
 * `stepIdMap` null (an install from before maps were kept, or a stage copy,
 * whose ids are Dev's) means identity: the definition is returned unchanged
 * and so is the map.
 *
 * @param {object} definition  the newer version, with the Blueprint's own step ids
 * @param {object|null} stepIdMap  `{ root: {old: new}, layers: {key: {old: new}} }`
 * @returns {{ definition: object, renameMap: object|null }}
 */
function applyRenameMap(definition, stepIdMap, { rekey = null } = {}) {
    if (!isPlainObject(stepIdMap) || !isPlainObject(definition)) {
        return { definition: clone(definition), renameMap: isPlainObject(stepIdMap) ? clone(stepIdMap) : null };
    }
    const rekeyDefinition = rekey || require('../../automation/portability').rekeyDefinition;
    const source = JSON.stringify(definition);

    for (let attempt = 0; attempt < MAX_REKEY_TRIES; attempt++) {
        const { definition: fresh, renameMap: drawn } = rekeyDefinition(definition);
        const targetOf = new Map();         // random id → the id it must become
        const renameMap = { root: {}, layers: {} };
        let usable = true;
        for (const [graphKey, map] of graphsOf(drawn)) {
            const stored = storedGraph(stepIdMap, graphKey);
            const out = {};
            const taken = new Set(Object.values(stored).filter(v => typeof v === 'string'));
            const given = new Set();        // a target id goes to one step only, whatever the map says
            for (const [oldId, randomId] of Object.entries(map)) {
                const named = typeof stored[oldId] === 'string' && STEP_ID_RE.test(stored[oldId]) ? stored[oldId] : null;
                const want = named && !given.has(named) ? named : null;
                if (want) given.add(want);
                // A random id must be new to the input, unique across graphs,
                // and never equal to an id the map hands to another step.
                if (source.includes(randomId) || targetOf.has(randomId) || (!want && taken.has(randomId))) usable = false;
                targetOf.set(randomId, want || randomId);
                out[oldId] = want || randomId;
            }
            // Ids the newer version dropped keep their entry: if a later version
            // brings the step back, it comes back under the same id.
            const merged = { ...stored, ...out };
            if (graphKey === 'root') renameMap.root = merged;
            else renameMap.layers[graphKey.slice('layer:'.length)] = merged;
        }
        for (const [graphKey, stored] of graphsOf(stepIdMap)) {
            if (graphKey !== 'root' && !(graphKey.slice('layer:'.length) in renameMap.layers)) {
                renameMap.layers[graphKey.slice('layer:'.length)] = { ...stored };
            }
        }
        if (!usable) continue;
        if (targetOf.size === 0) return { definition: fresh, renameMap };

        const pattern = new RegExp(
            `(?<![${ID_CHAR}])(${[...targetOf.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![${ID_CHAR}])`,
            'g',
        );
        const rewritten = JSON.stringify(fresh).replace(pattern, (m) => targetOf.get(m));
        return { definition: JSON.parse(rewritten), renameMap };
    }
    throw new Error('could not map the step ids of the newer version onto the installed ones');
}

// ── The installer's choices, read back (F3) ─────────────────────────────────

/**
 * The wiring an upgrade applies: what the installer chose at install time,
 * kept as `solution_bindings` rows. `null` when there is nothing kept (an
 * install from before choices were kept, or one where nobody chose anything):
 * then an upgrade fills nothing in, exactly as it always did, because nobody
 * was asked.
 */
function wiringFromBindings(rows) {
    const { bindingsToResolutions, isEmptyResolutions } = require('./resolutions');
    const resolutions = bindingsToResolutions(rows);
    if (isEmptyResolutions(resolutions)) return null;
    return {
        resolutions,
        tables: [],
        // The installer already checked these when they picked them, so a
        // automation bound to one again is not a new thing to double-check.
        freshTableIds: new Set(resolutions.tables.map(t => t.datatableId).filter(Boolean)),
        createdForKey: new Map(),
    };
}

// ── Replacing one entity ────────────────────────────────────────────────────
//
// "An update changes what runs, never whether it runs" (F4): a part with a
// live copy gets its live pointer moved to the new version; a part that never
// went live stays a draft; on/off, audience and sharing are never touched.

async function replaceAutomation(entityId, entity, stamp, ctx, report, unresolved) {
    const { resolveRefs, applyResolutionsTo } = require('./install');
    const store = require('../../stores/automationStore');
    const row = await store.getAutomation(entityId);
    if (!row) throw new Error('that automation is gone');

    const holder = resolveRefs('automation', { definition: clone(entity.definition) }, ctx.refMap, unresolved);
    // The installer's choices, addressed by the Blueprint's step ids, so
    // before the ids are mapped onto the installed ones.
    applyResolutionsTo(holder.definition, entity.ref, ctx, report);
    const { definition, renameMap } = applyRenameMap(holder.definition, stamp?.stepIdMap ?? null);

    // A Step (block) is live through `published_version`, the snapshot its
    // callers execute (D14); an automation through its live copy. A layer has
    // neither: it runs inside its caller.
    if (row.kind === 'block') {
        await store.updateAutomation(entityId, { definition }, ctx.ownerId);
        if (row.publishedVersion !== null && row.publishedVersion !== undefined) {
            await store.publishStep(entityId, ctx.ownerId);
        }
        await ctx.stamp({
            ref: entity.ref, kind: 'automation', entityId, payload: definition,
            ...(renameMap ? { stepIdMap: renameMap } : {}),
        });
        return;
    }
    const hasLive = row.liveVersion !== null && row.liveVersion !== undefined;
    const goLive = ctx.goLive();
    const updates = { definition };
    if (hasLive) {
        // The trigger columns go live with the definition, as on a publish.
        const planned = goLive.planGoLive(row, definition, { willBeActive: !!row.isActive });
        if (!planned.ok) throw new Error(planned.message);
        Object.assign(updates, planned.columns);
    }
    await store.updateAutomation(entityId, updates, ctx.ownerId, { goLive: hasLive });
    if (hasLive) {
        const { warnings } = await goLive.convergeAfterPublish({
            automation: row, definition, previousLive: row.liveDefinition || null, isActive: !!row.isActive,
            ownerId: row.userId || ctx.ownerId, organizationId: ctx.organizationId, reason: 'upgrade',
        });
        for (const w of warnings || []) report.warnings.push(`"${entity.title || entity.ref}" was updated, but ${w.step} did not finish: ${w.message}`);
    }
    await ctx.stamp({
        ref: entity.ref, kind: 'automation', entityId, payload: definition,
        ...(renameMap ? { stepIdMap: renameMap } : {}),
    });
}

async function replaceApp(entityId, entity, ctx, unresolved) {
    const { resolveRefs } = require('./install');
    const store = require('../../stores/studioAppStore');
    const { definition } = resolveRefs('app', { definition: clone(entity.definition) }, ctx.refMap, unresolved);
    await store.saveDefinition(entityId, ctx.ownerId, definition);
    // Published = it has a live copy: the audience moves to the new version.
    // Unpublished stays unpublished (a gallery install is never a managed part,
    // whose live copy only a stage deploy moves).
    const row = await store.getStudioApp(entityId);
    if (row && row.isPublished) {
        await store.setStudioAppPublished(entityId, true, row.userId || ctx.ownerId, undefined, undefined,
            row.definition ?? definition, Number.isInteger(row.definitionVersion) ? row.definitionVersion : undefined);
    }
    await ctx.stamp({ ref: entity.ref, kind: 'app', entityId, payload: definition });
}

async function replaceWebpage(entityId, entity, ctx) {
    const store = require('../../stores/webpageStore');
    const row = await store.getWebpageRaw(entityId);
    const owner = row?.userId || ctx.ownerId;
    const files = entity.files || {};
    for (const [slot, content] of [['index.html', files.html], ['style.css', files.css], ['script.js', files.js]]) {
        if (content !== undefined) await store.writeSlot(owner, entityId, slot, content);
    }
    // Een upgrade herschrijft alle drie de slots, dus hij kan een
    // `<bf-table source="…">` net zo goed WEGHALEN als toevoegen —
    // en de dependents-index is delete-then-insert, dus zonder
    // reconcile blijft de rij van de VORIGE versie staan. De
    // tabel-eigenaar krijgt dan een 409 over een pagina die zijn tabel
    // niet meer gebruikt. Zelfde reden als op het install-pad, en hier
    // sterker: daar is de pagina nieuw, hier heeft ze al een index.
    require('../../core/webpages/webpageUsageSync').reconcileWebpageUsageDetached(entityId);
    // A pinned snapshot is the page's live copy: readers move to the new
    // version through a new snapshot, the way the publish route pins one
    // (flush, snapshot, pointer). An unpublished page has no pin and gets none.
    if (row && row.publishedVersionId) {
        try { await ctx.webpageDb().flush(owner, entityId); } catch { /* best effort, as on publish */ }
        const version = await store.createVersion(owner, entityId, 'Published', null, 'published');
        const ok = version && await store.setPublishedVersion(entityId, owner, version.id);
        if (!ok) throw new Error('the new version could not be published');
    }
    await ctx.stamp({ ref: entity.ref, kind: 'webpage', entityId, payload: files });
}

async function replaceAgent(entityId, entity, ctx, report, unresolved) {
    const { resolveRefs } = require('./install');
    // Through the store's own save path, and with the authority rule
    // re-applied on the way in: an UPDATE is as much a way to widen a
    // grant as a create is, so `actAs` is written to 'viewer' here too
    // rather than trusted from the file.
    const agentStore = require('../../stores/agentStore');
    const live = await agentStore.getAgent(entityId);
    if (!live) throw new Error('that agent is gone');
    const { config } = resolveRefs('agent', { config: clone(entity.config || {}) }, ctx.refMap, unresolved);
    if (config.tools && typeof config.tools === 'object') {
        for (const key of Object.keys(config.tools)) {
            if (config.tools[key] && typeof config.tools[key] === 'object') config.tools[key].actAs = 'viewer';
        }
    }
    await agentStore.updateAgent(
        entityId,
        entity.name || live.name,
        entity.description || '',
        entity.systemPrompt || '',
        ctx.ownerId,
        entity.model || null,
        Array.isArray(entity.starterPrompts) ? entity.starterPrompts : [],
        live.avatar || null,
        entity.threadsEnabled !== false,
        entity.copyEnabled !== false,
        entity.workspaceEnabled === true,
        config,
        // embed_enabled: whatever the owner set. An update neither switches
        // embedding on nor takes it away (F3).
        (live.embed_enabled ?? live.embedEnabled) === true,
        // organization / shared groups / category: `undefined` =
        // preserve (updateAgent's undefined-means-preserve rule).
        undefined,
        undefined,
        undefined,
        // The package replaces `system_prompt` wholesale, so any
        // structured role stored against the OLD prompt now describes
        // an agent that no longer exists — and the next save would
        // render those stale fields straight back over the packaged
        // text. Clearing it is not a loss: the row reads back as free
        // mode over the prompt the package just installed (A1c).
        { persona: null },
    );
    // A published agent serves its published config: move it along.
    if (Number(live.published_version ?? live.publishedVersion) > 0) {
        const out = await agentStore.publishAgentVersion(entityId, { config });
        if (!out || out.ok !== true) {
            report.warnings.push(`"${entity.name || entity.ref}" was updated, but its published version could not be moved to it. Publish the agent by hand.`);
        }
    }
    await ctx.stamp({ ref: entity.ref, kind: 'agent', entityId, payload: config });
}

async function replaceEntity(kind, entityId, entity, stamp, ctx, report) {
    const unresolved = [];
    try {
        if (kind === 'automation') await replaceAutomation(entityId, entity, stamp, ctx, report, unresolved);
        else if (kind === 'app') await replaceApp(entityId, entity, ctx, unresolved);
        else if (kind === 'webpage') await replaceWebpage(entityId, entity, ctx);
        else if (kind === 'agent') await replaceAgent(entityId, entity, ctx, report, unresolved);
        report.replaced.push({ ref: entity.ref, kind, entityId });
    } catch (err) {
        report.failed.push({ ref: entity.ref, kind, why: err.message });
    }
    for (const ref of [...new Set(unresolved)]) {
        report.warnings.push(`A reference to "${ref}" could not be connected while updating "${entity.ref}".`);
    }
}

/**
 * Apply an upgrade.
 *
 * Replaces what nobody touched, leaves what somebody did, creates what the new
 * version adds, and deletes nothing at all — see the header. The plan is
 * computed first and returned alongside the outcome, so the caller can show
 * what was skipped and why.
 *
 * What the installer chose at install time (connections, approvers, tables)
 * is read back from `solution_bindings` and filled into the newer version's
 * holes again (F3); every automation keeps the step ids its install gave it
 * (F10); a part that is live stays live on the new version and a draft stays
 * a draft (F4); added parts get their references patched before they are
 * stamped (F11); and the project records the version it is now on (F5),
 * once every part landed: with a retryable entry in `report.failed` the
 * version stays where it was (`versionRecorded: false`), so the same release
 * can be retried. A `permanent` skip (capability or content refusal) does not
 * hold the version back: a retry would refuse it again.
 *
 * Throws HttpError 503 `bindings_unavailable` when the kept install choices
 * cannot be read: nothing is written then.
 *
 * `deps` (all optional): `bindings` ({ listBindings }), `projectStore`
 * ({ setInstalledVersion }), `goLive` ({ planGoLive, convergeAfterPublish }),
 * `webpageDb` ({ flush }).
 */
async function applyUpgrade({
    projectId, manifest, ownerId, organizationId = null, can = () => true, req = null, deps = {},
} = {}) {
    if (!ownerId) return { ok: false, errors: ['An installer is required.'] };

    const planned = await planUpgrade({ projectId, manifest });
    if (!planned.ok) return planned;

    const { plan } = planned;
    const stamps = await require('../../stores/blueprintStore').listStamps(projectId);
    // The CHECKED manifest, not the caller's own object: sanitizeManifest hands
    // back a copy with the never-installable keys removed, and building from
    // the raw input here would have quietly reinstated them for everything this
    // upgrade ADDS.
    const entities = planned.manifest.solution.entities;
    const toVersion = Number.isInteger(planned.toVersion) && planned.toVersion > 0 ? planned.toVersion : 1;

    // Unreadable choices are not "no choices": going on would empty every
    // connection and approver the installer set, which is the defect this
    // read exists to prevent. Refused before anything is written.
    //
    // A SERVER fault, so not an `ok: false` (the route answers those with a
    // 400 that echoes the text): a 503 with a fixed sentence. The driver's own
    // message goes to the log, never to the client.
    let bindingRows;
    try {
        bindingRows = await (deps.bindings || require('../../stores/solutionStageStore')).listBindings(projectId);
    } catch (err) {
        log.error(`[Blueprint] upgrade of ${projectId}: the kept install choices could not be read:`, err.message);
        throw new HttpError(503, 'bindings_unavailable',
            'The choices made when this Solution was installed could not be read, so nothing was updated. Try again later.');
    }

    const report = {
        replaced: [], skipped: plan.skip, missing: plan.missing,
        added: { automations: [], apps: [], webpages: [], datatables: [], agents: [], knowledgeBases: [] },
        failed: [], warnings: [], resolved: [],
    };

    const {
        makeInstallCtx, installAutomations, installApps, installWebpages,
        installDatatables, installAgents, installKnowledgeBases, patchReferences, stampAll, tablesForRebind,
    } = require('./install');

    // Existing entities keep their real ids, so a reference to one of them
    // resolves to what is already installed rather than to a fresh copy.
    const refMap = new Map([...stamps.entries()].map(([ref, s]) => [ref, s.entityId]));
    const ctx = makeInstallCtx({
        ownerId, organizationId, projectId, refMap, can, req, deps,
        installedVersion: toVersion,
        wiring: wiringFromBindings(bindingRows),
    });
    ctx.goLive = () => deps.goLive || require('../../automation/goLive');
    ctx.webpageDb = () => deps.webpageDb || require('../../stores/webpageDbStore');

    // Additions first, so a replacement that references a newly-added entity
    // finds a real id waiting for it.
    const addedRefs = new Set(plan.add.map(a => a.ref));
    const addReport = { installed: report.added, skipped: [], warnings: [], resolved: report.resolved };
    const onlyAdded = (list) => (list || []).filter(e => addedRefs.has(e.ref));
    await installDatatables(onlyAdded(entities.datatables), ctx, addReport);
    await installKnowledgeBases(onlyAdded(entities.knowledgeBases), ctx, addReport);
    // The tables a kept table choice may bind to: the bundle's own (installed
    // now or at install time) first. Its warnings were said at install time.
    if (ctx.wiring) ctx.wiring.tables = tablesForRebind(entities.datatables || [], ctx, { warnings: [] });
    await installAutomations(onlyAdded(entities.automations), ctx, addReport);
    await installApps(onlyAdded(entities.apps), ctx, addReport);
    await installWebpages(onlyAdded(entities.webpages), ctx, addReport);
    await installAgents(onlyAdded(entities.agents), ctx, addReport);
    // F11: an added part's references, patched like an install patches them.
    await patchReferences(planned.manifest, ctx, addReport, { refs: addedRefs });
    report.failed.push(...addReport.skipped);
    report.warnings.push(...addReport.warnings);

    const byRef = new Map();
    for (const [kind, list] of PLAN_LISTS(entities)) {
        for (const e of (list || [])) byRef.set(e.ref, { kind, entity: e });
    }
    for (const item of plan.replace) {
        const found = byRef.get(item.ref);
        if (found) await replaceEntity(found.kind, item.entityId, found.entity, stamps.get(item.ref), ctx, report);
    }

    // Stamped last, from what each part looks like now (F2).
    await stampAll(ctx, report);

    for (const m of plan.missing) {
        report.warnings.push(`"${m.ref}" was installed once and is gone now, so this update left it alone — deleting it was a decision, not damage.`);
    }

    // F5: the project now runs this version — but only when ALL of it landed.
    // The route refuses an upgrade to a version that is not newer than the
    // recorded one (`isNewer`), so recording it over a failed part would make
    // that part impossible to retry from this release: the owner would need a
    // newer publication to get it. Left unrecorded, the same release can be
    // applied again; what did land is stamped pristine and is simply replaced
    // with the same thing.
    //
    // A deliberate skip (`permanent`: the plan lacks the capability, or the
    // bundle's own content is refused) does not count: retrying the same
    // release gives the same answer, so holding the version back would only
    // let this release be re-applied without end. Those parts are reported
    // and the version is recorded.
    const retryable = report.failed.filter(f => !f?.permanent);
    const complete = retryable.length === 0;
    if (complete) {
        try {
            await (deps.projectStore || require('../../stores/projectStore')).setInstalledVersion(projectId, toVersion);
        } catch (err) {
            report.warnings.push(`The update was applied, but the version it brought could not be recorded: ${err.message}`);
        }
    } else {
        report.warnings.push(`${retryable.length} part(s) could not be updated, so this Solution still counts as running its previous version. Fix what is named and apply this update again.`);
    }

    return { ok: true, toVersion: planned.toVersion, versionRecorded: complete, report };
}

module.exports = {
    planUpgrade, applyUpgrade, isNewer, currentPayload, REPLACEABLE_KINDS,
    applyRenameMap, wiringFromBindings,
};
