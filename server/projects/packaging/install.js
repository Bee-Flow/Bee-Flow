/**
 * Install a Blueprint: turn a written-down Solution back into a live one.
 *
 * ── The two passes, and why there have to be two ───────────────────────────
 *
 * Entities reference each other by bundle-local `{ $ref }`, and a ref can only
 * be resolved once its target has a real id. So everything is created first,
 * building ref → id as it goes, and only then are the references patched in.
 * This is exactly the shape templateInstall.buildSeed already uses for seed-row
 * relations — one two-pass idea in the product, not two.
 *
 * ── Order within the first pass ────────────────────────────────────────────
 *
 * The project row comes first so every entity can be stamped with its
 * `project_id` at INSERT rather than patched afterwards. Then blocks and layers
 * before automations, so a `call_block` target exists before its caller.
 *
 * ── Nothing installed is live ──────────────────────────────────────────────
 *
 * An installed Blueprint must never start firing schedules and webhooks on
 * arrival. createAutomation already inserts is_active = FALSE / is_draft = TRUE,
 * so this is a guarantee of the store rather than something re-implemented
 * here — and the test asserts it rather than trusting it. Webpages are created
 * unpublished for the same reason, which is also what cloneWebpage does.
 *
 * ── One owner ──────────────────────────────────────────────────────────────
 *
 * Every entity is created under the INSTALLER. A cross-owner edge refuses at
 * the moment someone presses the button (actionExecutor and the webpage bridge
 * both run acts-as-owner), so an install that spread ownership around would be
 * born with the exact defect the Flow tab exists to surface.
 *
 * ── Missing capabilities skip, never fail ──────────────────────────────────
 *
 * A Blueprint with apps landing on an install without App Studio should install
 * its automations and say what it could not install. Refusing the whole thing
 * would make a partly-usable Solution unusable, and the `requires` entry exists
 * precisely so this can be reported rather than guessed.
 *
 * ── Best-effort, but never silent ──────────────────────────────────────────
 *
 * Every step that can fail is caught and NAMED in the report. An install that
 * half-worked and said nothing is worse than one that failed loudly.
 *
 * ── A page's bridge grants are REQUIRES, not data ───────────────────────────
 *
 * `bridge_grants` decides what a webpage's script.js may call through
 * window.beeflowAI / beeflowAutomations / beeflowIntegrations — and those
 * bridges run AS THE PAGE'S AUTHOR (core/webpages/webpageBridgeAuth.js), who
 * after an install is the INSTALLER. So a granted tool in a Blueprint is not a
 * description of the page, it is a request for authority over the account of
 * whoever presses install. It is treated the same way an app's `requires` is:
 * shown, and re-assigned by hand.
 *
 * Install therefore writes the grants it can VOUCH for and nothing else:
 *
 *   ai           the store's own default — public AI OFF, whatever the file says
 *   automations  only entries that pointed at an automation INSIDE this bundle, by
 *                `{ $ref }`, resolved to the copy this install just created
 *   tables       the same rule for tables (F14); public columns never
 *   agent        the same rule for the page's agent, or none
 *   integrations empty. Always. A tool name is authority.
 *
 * updateBridgeGrants replaces the WHOLE column with the normalizer's output, so
 * a grant kind that does not exist yet cannot arrive through this path either:
 * an unknown key in the file is dropped by normalizeBridgeGrants, and the
 * column that lands has the keys it wrote and no others. That is the narrow
 * direction on purpose — the day a new grant kind exists, an installed page
 * starts without one rather than with the file's.
 *
 * What the file asked for is NOT thrown away, it is REPORTED:
 * `collectGrantRequires` reads it off the raw manifest into `report.grantRequires`
 * so the install wizard can list it and the installer can grant it themselves,
 * with the connection status in front of them. Read off the RAW manifest and
 * not the checked copy, because sanitizeManifest has already stripped the
 * `ai.public*` keys by then — the rows exist precisely to show what was
 * stripped.
 *
 * ── What the INSTALLER supplies: `resolutions` ─────────────────────────────
 *
 * The mirror image of the paragraph above. Bridge grants are things the file
 * asks for and the install refuses; `resolutions` are things the file
 * deliberately does NOT carry and the installer hands over instead — which
 * table a step should use, which HTTP credential, who approves. The wizard's
 * Connect step collects them; projects/packaging/resolutions.js is the only
 * place that turns them into definition edits, and its one rule is that a
 * resolution fills a hole and never overwrites a step that is already wired.
 *
 * Tables are re-linked through automation/portability.rebindDatatables — the
 * same function the single-automation import uses, so "a `datatableKey` finds its
 * table" has one implementation. Both the tables this bundle brought WITH it
 * and the ones the installer picked go into the same list, which is why a
 * automation that ships alongside its own table now arrives wired rather than
 * pointing at nothing.
 */

'use strict';

const { sanitizeManifest, rewriteRefs, readSource } = require('./manifest');
const { normalizeResolutions, applyStepResolutions, resolutionsToBindings } = require('./resolutions');
const { fromRefs, visitPointers, isRef } = require('./pointers');
const log = require('../../telemetry/log');
const crypto = require('crypto');

/**
 * Waar deze installatie vandaan komt, en met hoeveel gezag dat vaststaat.
 *
 * Twee bronnen, en het verschil ertussen is de hele reden dat deze functie
 * bestaat in plaats van drie regels in `installBlueprint`:
 *
 *   DE SERVER heeft de galerijrij zelf gelezen (`blueprintId` +
 *   `blueprintOrgId` komen uit `resolveManifest`, dat eerst `canRead` draaide).
 *   Dat is vastgesteld, niet beweerd.
 *
 *   HET BESTAND beweert iets over zichzelf (`manifest.source`). Zo'n bewering
 *   is INVOER VAN BUITEN: iedereen met een teksteditor kan er `orgId: 'org_a'`
 *   in zetten.
 *
 * Wat hier gebeurt met die twee:
 *
 *   1. HET VASTGESTELDE WINT ALTIJD. Heeft de server een Blueprint opgezocht,
 *      dan komt de organisatie uit die rij en NIET uit het bestand — anders zou
 *      een galerij-installatie de bewering van het bestand over de eigen
 *      lezing van de server heen schrijven.
 *   2. ZONDER GALERIJRIJ WORDT DE BEWERING PAS VASTGELEGD ALS ZIJ KLOPT. Een
 *      doorgestuurd bestand kan zichzelf alleen via `source.blueprintId` aan
 *      zijn Blueprint koppelen, en zonder die koppeling telt geen enkele
 *      bestandsinstallatie mee. Maar ONGECONTROLEERD overnemen maakte van de
 *      installatieteller een getal dat de lezer zelf kon zetten: wie één
 *      gepubliceerd bestand van organisatie A had, kon daarin `bp_x` in `bp_y`
 *      veranderen en de teller van een Blueprint laten oplopen die nul keer is
 *      geïnstalleerd. Het scherm noemt dat getal een ONDERGRENS, dus naar boven
 *      bijsturen is precies de fout die niet waar te maken is.
 *      Daarom moet de bewering eerst kloppen: `verifyClaimedBlueprint` legt
 *      haar alleen vast als er een galerijrij met dat id bestaat ÉN die rij
 *      dezelfde `solution_key` draagt als dit manifest. Dan hoort het bestand
 *      aantoonbaar bij die Blueprint. Vastleggen is nog steeds geen toegang:
 *      wie de telling mag zien beslist `requireProjectRole('owner')` op het
 *      bronproject, en die vraag raakt deze kolommen niet aan. Klopt de
 *      bewering niet — of wijst zij nergens naar — dan leest zij als ONBEKEND,
 *      net als een verwijderde Blueprint.
 *   3. HET VERSIENUMMER KOMT UIT ÉÉN VELD: `manifest.solution.version`,
 *      hetzelfde nummer dat elke entiteitsstempel meekrijgt. `source.version`
 *      is een tweede kopie van datzelfde getal en wordt hier bewust NIET
 *      gelezen — twee nummers die kunnen verschillen zouden een installatie
 *      opleveren waarvan het project iets anders zegt dan zijn eigen stempels.
 *
 * Puur en geëxporteerd, zodat de vijandige gevallen op zichzelf te toetsen zijn.
 */
function provenanceOf({ blueprintId = null, blueprintOrgId = null, manifest = null, claimVerified = false } = {}) {
    const claimed = readSource(manifest);
    const resolvedId = typeof blueprintId === 'string' && blueprintId ? blueprintId : null;
    const resolvedOrg = typeof blueprintOrgId === 'string' && blueprintOrgId ? blueprintOrgId : null;
    const version = Number(manifest?.solution?.version);
    // De bewering telt alleen mee als iemand haar heeft nagelopen. `claimVerified`
    // komt van `verifyClaimedBlueprint`; deze functie blijft puur en doet zelf
    // geen lees, zodat de vijandige gevallen los te toetsen zijn.
    const acceptedClaimId = claimVerified ? claimed.blueprintId : null;
    return {
        installedFromBlueprintId: resolvedId || acceptedClaimId,
        // De organisatie hoort bij het id: zonder aanvaard id is er geen
        // bronorganisatie om vast te leggen. Anders zou een project een
        // organisatie-id van een andere tenant dragen zonder dat er iets is dat
        // die bewering staaft.
        installedFromOrgId: resolvedId ? resolvedOrg : (acceptedClaimId ? claimed.orgId : null),
        installedVersion: Number.isInteger(version) && version > 0 ? version : 1,
    };
}

/**
 * Klopt de bewering die dit bestand over zijn eigen Blueprint doet?
 *
 * Eén lees, één boolean. Er komt NIETS van de galerijrij naar buiten — niet de
 * naam, niet de organisatie, niet de maker — dus deze controle is geen
 * leesrecht op een Blueprint van een andere organisatie; zij beantwoordt
 * uitsluitend "hoort dit bestand bij dat id".
 *
 * De vergelijking is `solution_key`, want dat is het enige veld dat een
 * Blueprint aan een Oplossing bindt (`sol_<projectId>`, zie
 * packaging/manifest.buildManifest) en het is niet te vervalsen zonder ook te
 * beweren dat het bestand een ándere Oplossing IS.
 *
 * Meta-lees zonder manifest: van de galerijrij is hier alleen `solutionKey`
 * nodig, en die rij kan megabytes JSONB dragen.
 *
 * Gooit niet. Kan de rij niet gelezen worden, dan is de bewering NIET
 * geverifieerd — onbekend versmalt, dus de installatie legt geen herkomst vast.
 */
async function verifyClaimedBlueprint({ claimedId = null, solutionKey = null } = {}) {
    if (typeof claimedId !== 'string' || !claimedId) return false;
    if (typeof solutionKey !== 'string' || !solutionKey) return false;
    try {
        const store = require('../../stores/blueprintStore');
        const row = await store.getBlueprintById(claimedId, { includeManifest: false });
        return !!row && row.solutionKey === solutionKey;
    } catch (err) {
        log.warn('[Blueprint] could not check a claimed Blueprint id:', err.message);
        return false;
    }
}

/**
 * What an entity looked like the moment it was installed.
 *
 * hashDefinition is App Studio's, reused rather than rewritten: jsonb does not
 * preserve key order, so a second hasher would disagree with the first on
 * documents that are identical, and upgrade would then call a pristine entity
 * dirty. One hasher.
 */
function installHashOf(payload) {
    const { hashDefinition } = require('../../appStudio/templateUpgrade');
    return hashDefinition(payload);
}

/** Blocks and layers are building materials: they must exist before callers. */
const KIND_ORDER = { block: 0, layer: 0, automation: 1 };

function clone(v) {
    try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v ?? null)); }
}

/**
 * Every `{ $ref }` of one holder back to a real id: the registered pointer
 * locations through pointers.fromRefs, then the generic rewrite as a backstop
 * for a `$ref` the registry has no row for (a hand-made file), so nothing that
 * looks like a reference survives into a stored payload. Mutates `payload`;
 * every ref with no target lands in `unresolved`.
 */
function resolveRefs(holderKind, payload, refMap, unresolved, templateVersions = null) {
    const { unresolved: missed } = fromRefs(holderKind, payload, refMap);
    for (const m of missed) unresolved.push(m.ref);
    for (const key of Object.keys(payload)) payload[key] = rewriteRefs(payload[key], refMap, unresolved);
    if (holderKind === 'automation') pinTemplateVersions(payload.definition, templateVersions);
    return payload;
}

/**
 * Every `fill_document` step that names a template this install created is
 * pinned to that copy's revision (`documentVersionId`), so the automation renders
 * exactly the template it shipped with, and a stage switches template content
 * with the automation's own flip. `versionByDocId` is `ctx.templateVersions`
 * (template id → revision id); a step naming anything else is left alone.
 *
 * @param {object|null} definition  an automation definition, mutated
 * @param {Map<string, string>|null} versionByDocId
 */
function pinTemplateVersions(definition, versionByDocId) {
    if (!definition || !(versionByDocId instanceof Map) || !versionByDocId.size) return;
    require('../../automation/portability').walkAllSteps(definition, (step, _layerKey, isTrigger) => {
        if (isTrigger || step.type !== 'fill_document') return;
        const version = versionByDocId.get(step.documentId);
        if (typeof version === 'string' && version) step.documentVersionId = version;
    });
}

/**
 * Only the `{ $ref }`s whose target already exists, and only of the given
 * target kinds; every other ref is left for the patch pass. Used before a
 * automation's resolutions run, so a datatable step that points at a table this
 * bundle carries is already wired when `rebindDatatables` looks for holes.
 */
function resolveKnownRefs(holderKind, payload, refMap, targetKinds) {
    visitPointers(holderKind, payload, (ptr) => {
        if (!targetKinds.includes(ptr.targetKind)) return;
        const value = ptr.get();
        const real = (v) => (isRef(v) && typeof refMap.get(v.$ref) === 'string' ? refMap.get(v.$ref) : v);
        if (ptr.many) { if (Array.isArray(value)) ptr.set(value.map(real)); return; }
        const next = real(value);
        if (next !== value) ptr.set(next);
    });
}

/** `<key>_2` … `<key>_9`: the copies a key clash may try (F7). */
const MAX_KEY_SUFFIX = 9;
/** The datatable key grammar allows 63 characters (vocabulary.js KEY_RE). */
const MAX_TABLE_KEY = 63;

function suffixedKey(key, n) {
    const tail = `_${n}`;
    return `${key.slice(0, MAX_TABLE_KEY - tail.length)}${tail}`;
}

/** The unique (scope, key) index refused this key; the same test createStudioDatatable uses. */
function isKeyClash(err) {
    return /uq_datatables_scope_key|already exists|duplicate key/i.test(String(err && err.message));
}

/** The installed version every stamp of this install carries. */
function versionOf(solution) {
    const v = Number(solution?.version);
    return Number.isInteger(v) && v > 0 ? v : 1;
}

/**
 * The context every install function reads, with the defaults an install has.
 *
 *   ownerId / projectId / organizationId  who owns what is created, and where
 *     it is filed. The stage engine passes the run-as user and the stage
 *     project; a gallery install the installer and the new Solution.
 *   rekey            fresh step ids per automation (default). The stage engine
 *     passes false: a stage keeps Dev's step ids (design D3).
 *   scope            the datatable scope; default the organisation, else the owner.
 *   datatableKeyFor  (entity) → the physical table key; default `entity.key`.
 *     A key that differs from the bundle's is recorded as `logical_key`.
 *   dataModelOptions passed to studioAppDataStore.saveDataModel.
 *   managedWrite     a deployment's capability (`{ deploymentId }`), for the
 *     stage engine filing a part INTO a stage project: the store guards
 *     (stores/lib/managedParts.js) refuse that write with 409 managed_part
 *     without it. Handed to every guarded store write this file makes
 *     (`writeOpts`); null for a gallery install or an upgrade.
 *   installedVersion the version every stamp carries.
 *   wiring           the installer's resolutions; null applies none.
 *   templateVersions (filled by the installer) template id → revision id.
 *
 * `stamp` only COLLECTS `{ ref, kind, entityId, payload, stepIdMap }`;
 * `stampAll` writes them once every reference is patched (F2).
 */
function makeInstallCtx({
    ownerId, organizationId = null, projectId = null, refMap = new Map(), can = () => true, req = null,
    wiring = null, rekey = true, scope = null, datatableKeyFor = null, dataModelOptions = null,
    managedWrite = null, installedVersion = 1, releaseId = undefined, deps = {},
} = {}) {
    const ctx = {
        ownerId, organizationId, projectId, refMap, can, req, wiring, rekey, scope, datatableKeyFor,
        dataModelOptions, managedWrite, installedVersion, releaseId, deps, stamped: [],
        // Template id → the revision a fill_document step is pinned to (installDocumentTemplates).
        templateVersions: new Map(),
    };
    ctx.stamp = async (entry) => { ctx.stamped.push(entry); };
    return ctx;
}

/**
 * The options a guarded store write takes from this ctx: the deployment's
 * capability when the stage engine handed one over, nothing otherwise (a
 * gallery install or an upgrade writes outside any stage).
 */
function writeOpts(ctx) {
    return ctx && ctx.managedWrite ? { managedWrite: ctx.managedWrite } : {};
}

/** The kinds whose CURRENT payload an upgrade compares; the rest keep the payload install wrote. */
const READ_BACK_KINDS = new Set(['automation', 'app', 'webpage', 'agent']);

/**
 * Write the stamps collected in `ctx.stamped`, after every reference and every
 * resolution is in place (F2). The hash is of what the entity looks like NOW,
 * read through upgrade.currentPayload: that is the payload a later upgrade
 * compares against, so an untouched entity reads as pristine. A kind upgrade
 * never rereads (tables, knowledge bases) keeps the payload install wrote.
 *
 * Best-effort, never fatal: a Solution that installed but cannot be upgraded
 * later is a smaller problem than one that refused to install. A missing stamp
 * makes that entity ineligible for an automatic upgrade, the safe default.
 */
async function stampAll(ctx, report) {
    const { currentPayload } = require('./upgrade');
    const blueprintStore = require('../../stores/blueprintStore');
    const byRef = new Map();
    for (const entry of ctx.stamped.splice(0)) byRef.set(entry.ref, entry);
    for (const entry of byRef.values()) {
        let payload = entry.payload;
        if (READ_BACK_KINDS.has(entry.kind)) {
            try {
                const now = await currentPayload(entry.kind, entry.entityId);
                if (now !== null && now !== undefined) payload = now;
            } catch (err) {
                log.warn(`[Blueprint] could not read "${entry.ref}" back for its stamp: ${err.message}`);
            }
        }
        try {
            await blueprintStore.upsertStamp(null, {
                projectId: ctx.projectId, ref: entry.ref, kind: entry.kind, entityId: entry.entityId,
                installHash: installHashOf(payload ?? {}),
                installedVersion: ctx.installedVersion,
                ...(entry.stepIdMap !== undefined ? { stepIdMap: entry.stepIdMap } : {}),
                ...(ctx.releaseId !== undefined ? { releaseId: ctx.releaseId } : {}),
            });
        } catch (err) {
            report.warnings.push(`Could not record how "${entry.ref}" was installed, so it will not be offered future updates automatically: ${err.message}`);
        }
    }
}

/**
 * Put back the three things scrub.js emptied on the way out, for ONE automation.
 *
 * Connections and approvers come from the installer's `resolutions`; tables are
 * re-linked by KEY through the shared `rebindDatatables`, over the union of the
 * tables this bundle brought with it and the ones the installer picked.
 *
 * The reporting distinguishes three cases, because they need three different
 * things from the reader:
 *
 *   - bound to a table THIS INSTALL CREATED — silent. The Solution shipped that
 *     table; there is nothing for anyone to check.
 *   - bound to a table the INSTALLER PICKED — rebindDatatables' own sentence,
 *     which ends "check it is the right one before activating". Their pick, so
 *     their check.
 *   - not bound at all — always said out loud. A datatable step with no table
 *     is an automation that cannot run, and it used to arrive that way in silence.
 */
function applyResolutionsTo(definition, ref, ctx, report) {
    // `wiring` is null when nobody chose anything: a stage copy, or an
    // UPGRADE of a Solution whose install kept no choices (installed before
    // they were kept, or with none made). An upgrade has no wizard in front of
    // it, so it only ever re-applies what the installer chose at install time,
    // read back from `solution_bindings` (upgrade.js wiringFromBindings).
    if (!ctx.wiring) return [];
    const { rebindDatatables } = require('../../automation/portability');

    const { applied, ignored } = applyStepResolutions(definition, ref, ctx.wiring.resolutions);
    for (const row of applied) {
        report.resolved.push(row);
    }
    for (const row of ignored) {
        report.warnings.push(
            `What you chose for step "${row.stepId}" of "${ref}" was not used (${row.why.replace(/_/g, ' ')}) — open the automation and set it there.`,
        );
    }

    const { entries } = rebindDatatables(definition, ctx.wiring.tables);
    for (const entry of entries) {
        // Silent only for a table this install created — bundled, or conjured
        // empty because the installer asked for one.
        if (entry.matches === 1 && ctx.wiring.freshTableIds.has(entry.datatableId)) continue;
        report.warnings.push(entry.message);
    }
    // The connection and approver rows that landed on a step: only those are
    // kept for later updates (persistResolutions), so an update never repeats
    // "was not used" about a choice that never applied.
    return applied;
}

async function installAutomations(entities, ctx, report) {
    const { EXPORT_FORMAT, EXPORT_SCHEMA_VERSION, sanitizeImport, rekeyDefinition } = require('../../automation/portability');
    const automationStore = require('../../stores/automationStore');

    const ordered = [...entities].sort(
        (a, b) => (KIND_ORDER[a.kind] ?? 1) - (KIND_ORDER[b.kind] ?? 1),
    );

    for (const entity of ordered) {
        try {
            // Through the normal import path, so a Blueprint's automations are
            // validated by the same code a single-automation import uses.
            const { automation, errors } = sanitizeImport({
                format: EXPORT_FORMAT, schemaVersion: EXPORT_SCHEMA_VERSION, automation: clone(entity),
            });
            if (!automation) { report.skipped.push({ ref: entity.ref, kind: 'automation', why: errors.join(' '), permanent: true }); continue; }

            // Tables and knowledge bases are installed before any automation, so
            // their `$ref`s resolve now: a step wired to the bundle's own table
            // is then no hole for the resolutions below to fill or warn about.
            resolveKnownRefs('automation', { definition: automation.definition }, ctx.refMap, ['datatable', 'knowledgeBase']);

            // What the INSTALLER supplied, before the step ids change: a
            // resolution is addressed by the id the wizard read off the
            // manifest, and rekeyDefinition replaces every one of them.
            const applied = applyResolutionsTo(automation.definition, entity.ref, ctx, report);

            // Fresh step ids per graph, so two installs of the same Blueprint
            // never share them. The rename map goes on the stamp, so an
            // upgrade can put the same ids on the next version (F10). A stage
            // copy keeps Dev's ids (ctx.rekey false), and its map is identity.
            let definition = automation.definition;
            let stepIdMap = null;
            if (ctx.rekey !== false) ({ definition, renameMap: stepIdMap } = rekeyDefinition(definition));

            // A reusable Step is a `kind = 'block'` row, which only createStep
            // makes; createAutomation would land it as a plain automation.
            const created = entity.kind === 'block'
                ? await automationStore.createStep({
                    userId: ctx.ownerId,
                    organizationId: ctx.organizationId,
                    title: automation.title,
                    description: automation.description || '',
                    definition,
                })
                : await automationStore.createAutomation({
                    userId: ctx.ownerId,
                    organizationId: ctx.organizationId,
                    title: automation.title,
                    description: automation.description || '',
                    definition,
                    triggerType: automation.triggerType || 'manual',
                    scheduleCron: automation.scheduleCron || null,
                    scheduleTz: automation.scheduleTz || undefined,
                });
            await automationStore.updateAutomation(created.id, { projectId: ctx.projectId }, ctx.ownerId, writeOpts(ctx));
            ctx.refMap.set(entity.ref, created.id);
            // Kept only for an automation that actually landed (persistResolutions).
            if (ctx.wiring && Array.isArray(ctx.wiring.applied)) ctx.wiring.applied.push(...applied);
            await ctx.stamp({ ref: entity.ref, kind: 'automation', entityId: created.id, payload: definition, stepIdMap });
            report.installed.automations.push({ ref: entity.ref, id: created.id, title: automation.title });
        } catch (err) {
            report.skipped.push({ ref: entity.ref, kind: 'automation', why: err.message });
        }
    }
}

/**
 * An app's own tables (F13): the SHAPE capture read from
 * `studio_app_data_meta.model`, written through the store's own save path so
 * the physical schema is created the way an edit in App Studio creates it.
 *
 * A table that reads a Studio datatable this bundle carries arrives pointing
 * at the copy installed a moment ago (`$ref`). One that read a table outside
 * the bundle arrives with `datatableId: null`: it is left out and named,
 * because a linked table with no table behind it is a model the validator
 * refuses, and the installer links it in the app's data settings. A model that
 * still does not save is reported, never fatal: the app itself is installed.
 */
async function installAppDataModel(appId, entity, ctx, report) {
    if (!entity.dataModel || typeof entity.dataModel !== 'object' || Array.isArray(entity.dataModel)) return;
    const holder = { dataModel: clone(entity.dataModel) };
    const unresolved = [];
    resolveRefs('app', holder, ctx.refMap, unresolved);
    for (const ref of [...new Set(unresolved)]) {
        report.warnings.push(`A reference to "${ref}" in the data model of "${entity.name}" could not be connected — whatever it pointed at was not installed.`);
    }
    const model = holder.dataModel;
    const tables = Array.isArray(model.tables) ? model.tables : [];
    const unlinked = tables.filter(t => t && typeof t.source === 'object' && t.source !== null
        && (typeof t.source.datatableId !== 'string' || !t.source.datatableId));
    if (unlinked.length) {
        model.tables = tables.filter(t => !unlinked.includes(t));
        report.warnings.push(`"${entity.name}" reads ${unlinked.length} table(s) from outside this Solution (${unlinked.map(t => `"${t.key || t.id}"`).join(', ')}). They were left out: link them in the app's data settings.`);
    }
    try {
        const out = await require('../../stores/studioAppDataStore')
            .saveDataModel(appId, ctx.ownerId, model, { ...(ctx.dataModelOptions || {}), ...writeOpts(ctx) });
        if (out && out.ok === false) {
            const why = Array.isArray(out.errors) && out.errors.length ? out.errors.join(' ') : 'it was refused';
            report.warnings.push(`The data model of "${entity.name}" could not be set up (${why}). The app is installed without its own tables.`);
        }
    } catch (err) {
        report.warnings.push(`The data model of "${entity.name}" could not be set up: ${err.message}`);
    }
}

async function installApps(entities, ctx, report) {
    if (!ctx.can('app_studio')) {
        for (const e of entities) report.skipped.push({ ref: e.ref, kind: 'app', why: 'App Studio is not part of this plan.', permanent: true });
        return;
    }
    const studioAppStore = require('../../stores/studioAppStore');
    for (const entity of entities) {
        try {
            const created = await studioAppStore.createStudioApp({
                userId: ctx.ownerId,
                organizationId: ctx.organizationId,
                name: entity.name || 'Untitled app',
                description: entity.description || '',
                icon: entity.icon || null,
                accentColor: entity.accentColor || null,
                definition: clone(entity.definition),
            });
            await studioAppStore.setAppProject(created.id, ctx.ownerId, ctx.projectId);
            ctx.refMap.set(entity.ref, created.id);
            await installAppDataModel(created.id, entity, ctx, report);
            await ctx.stamp({ ref: entity.ref, kind: 'app', entityId: created.id, payload: entity.definition });
            report.installed.apps.push({ ref: entity.ref, id: created.id, name: entity.name });
        } catch (err) {
            report.skipped.push({ ref: entity.ref, kind: 'app', why: err.message });
        }
    }
}

async function installWebpages(entities, ctx, report) {
    if (!ctx.can('webpages')) {
        for (const e of entities) report.skipped.push({ ref: e.ref, kind: 'webpage', why: 'Webpages are not part of this plan.', permanent: true });
        return;
    }
    const webpageStore = require('../../stores/webpageStore');
    for (const entity of entities) {
        try {
            // The page's knowledge bases: only the ones this bundle carries,
            // by `$ref` (installed before any page). A bare id names a base of
            // the installation the file came from, so it is not a pointer here.
            const kbHolder = { knowledgeBaseIds: (Array.isArray(entity.knowledgeBaseIds) ? entity.knowledgeBaseIds : []).filter(isRef) };
            const { unresolved } = fromRefs('webpage', kbHolder, ctx.refMap);
            for (const u of unresolved) {
                report.warnings.push(`A reference to "${u.ref}" could not be connected — whatever it pointed at was not installed.`);
            }
            const created = await webpageStore.createWebpage({
                userId: ctx.ownerId,
                name: entity.name || 'Untitled Webpage',
                description: entity.description || '',
                instructions: entity.instructions || '',
                ...(kbHolder.knowledgeBaseIds.length ? { knowledgeBaseIds: kbHolder.knowledgeBaseIds } : {}),
            });
            // Unpublished by construction — an installed page must not be live
            // on arrival any more than an installed automation must be running.
            const files = entity.files || {};
            for (const [slot, content] of [['html', files.html], ['css', files.css], ['js', files.js]]) {
                if (content) await webpageStore.writeSlot(ctx.ownerId, created.id, slot, content, writeOpts(ctx));
            }
            await webpageStore.setWebpageProject(created.id, ctx.ownerId, ctx.projectId);
            // Een geïnstalleerde pagina is een pagina met code, dus ook zij
            // hoort in de dependents-index. Zonder dit stond de enige pagina die
            // niemand ooit met de hand bewerkt er nooit in — en dat is precies
            // het soort pagina waarvan de eigenaar niet weet welke tabellen
            // eronder hangen. Gedebouncet en detached; een install wacht niet.
            require('../../core/webpages/webpageUsageSync').reconcileWebpageUsageDetached(created.id);
            ctx.refMap.set(entity.ref, created.id);
            await ctx.stamp({ ref: entity.ref, kind: 'webpage', entityId: created.id, payload: entity.files || {} });
            report.installed.webpages.push({ ref: entity.ref, id: created.id, name: entity.name });
        } catch (err) {
            report.skipped.push({ ref: entity.ref, kind: 'webpage', why: err.message });
        }
    }
}

/**
 * Install the TABLES, schema only.
 *
 * ── Why the engine wiring is spelled out here ──────────────────────────────
 *
 * A `datatables` row, its entry in the scope model and the physical CREATE
 * TABLE have to land in ONE transaction. They used to be two on the create
 * route, and the failure mode is on the record: the metadata committed first,
 * so a DDL failure left a table the picker listed and every read 500'd on, and
 * the retry then hit the unique index on (scope, key). `createDatatable` takes
 * `applyPhysical` for exactly this reason, and it runs on the transaction's own
 * client. This is the third caller of that shape (POST /api/datatables and
 * scripts/assistantInstall.js are the other two); it is worth extracting once
 * there is somewhere shared to put it, and worth being explicit about until
 * then rather than approximating it.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 *
 * The installer's ORGANISATION when they have one, and their own account when
 * they do not. The Blueprint says nothing about scope — it cannot, the scope of
 * the install that produced it is meaningless here — so this is a decision made
 * at install time, and it is the same decision POST /api/datatables makes by
 * default.
 *
 * A failure is reported and skipped, never fatal: an install that half-worked
 * and said nothing is worse than one that failed loudly, and a rolled-back
 * transaction leaves nothing behind to be confused by.
 */
async function installDatatables(entities, ctx, report) {
    if (!entities.length) return;
    if (!ctx.can('automations')) {
        for (const e of entities) report.skipped.push({ ref: e.ref, kind: 'datatable', why: 'Tables are not part of this plan.', permanent: true });
        return;
    }
    const db = require('../../db');
    const datatableStore = require('../../stores/datatableStore');
    const datatableDbStore = require('../../stores/datatableDbStore');
    const { normalizeFields } = require('../../core/dataEngine/dataModel/datatableFields');
    const { migrationPlan } = require('../../core/dataEngine/dataModel/migrationPlan');
    const { ddlForTable } = require('../../core/dataEngine/dataModel/ddl');
    const { assertDatatableQuota } = require('../../core/dataEngine/datatableLimits');
    const PG = { dialect: 'pg' };

    const scope = ctx.scope || (ctx.organizationId
        ? datatableStore.orgScope(ctx.organizationId)
        : datatableStore.userScope(ctx.ownerId));
    const scopeKey = datatableDbStore.scopeKey(scope);

    for (const entity of entities) {
        try {
            // Through the same normaliser the create route uses: a column
            // without a stable id is INVISIBLE to the migration planner, so the
            // physical column is never created and nothing says so.
            const norm = normalizeFields(Array.isArray(entity.columns) ? entity.columns : [], []);
            if (!norm.ok) { report.skipped.push({ ref: entity.ref, kind: 'datatable', why: norm.error, permanent: true }); continue; }

            const rowScope = entity.rowScope === 'own' ? 'own' : 'all';
            const bundleKey = String(entity.key || '');
            const baseKey = typeof ctx.datatableKeyFor === 'function' ? String(ctx.datatableKeyFor(entity) || '') : bundleKey;
            const createWith = (key, logicalKey) => db.withTransaction(async (client) => datatableStore.createDatatable({
                scope, ownerUserId: ctx.ownerId,
                key,
                logicalKey,
                name: String(entity.name || 'Untitled table'),
                description: String(entity.description || ''),
                projectId: ctx.projectId,
                rowScope,
                retentionDays: Number.isInteger(entity.retentionDays) ? entity.retentionDays : null,
                retentionField: typeof entity.retentionField === 'string' && entity.retentionField ? entity.retentionField : 'created_at',
                subjectColumn: typeof entity.subjectColumn === 'string' && entity.subjectColumn ? entity.subjectColumn : null,
                fields: norm.fields,
            }, {
                client,
                // Filing a table into a stage project at INSERT is a stage write.
                ...writeOpts(ctx),
                assertQuota: (usage) => assertDatatableQuota(scope, { addTables: 1, usage }),
                applyPhysical: async (c, { before, next, modelVersion }) => {
                    const table = next.tables[next.tables.length - 1];
                    const ensure = ddlForTable(table, {
                        tableKeyById: new Map((next.tables || []).map(x => [x.id, x.key])),
                        dialect: 'pg', rowScope,
                    });
                    const plan = migrationPlan(before, next, { ...PG, onlyTableIds: [table.id] });
                    await datatableDbStore.applyMigration(scopeKey, scopeKey, [ensure, ...plan],
                        { client: c, targetVersion: modelVersion });
                },
            }));
            // F7: a second install of the same Blueprint in one organisation
            // meets its own first copy on the unique (scope, key) index. The
            // copy takes `<key>_<n>` and remembers the bundle's key as
            // `logical_key`; every in-bundle pointer reaches it through its
            // `$ref`, so nothing depends on the physical key.
            let created = null;
            let key = baseKey;
            for (let n = 1; !created; n++) {
                key = n === 1 ? baseKey : suffixedKey(baseKey, n);
                const logicalKey = key === bundleKey ? null : (bundleKey || null);
                try {
                    created = await createWith(key, logicalKey);
                } catch (err) {
                    try { datatableDbStore.invalidate(scopeKey); } catch { /* best effort */ }
                    if (n >= MAX_KEY_SUFFIX || !isKeyClash(err)) throw err;
                }
            }
            datatableDbStore.invalidate(scopeKey);
            ctx.refMap.set(entity.ref, created.id);
            await ctx.stamp({ ref: entity.ref, kind: 'datatable', entityId: created.id, payload: { columns: norm.fields } });
            report.installed.datatables.push({ ref: entity.ref, id: created.id, name: entity.name, ...(key !== baseKey ? { key } : {}) });
            if (key !== baseKey) {
                report.warnings.push(`A table with the key "${baseKey}" already exists here, so "${entity.name || baseKey}" was created as "${key}".`);
            }
        } catch (err) {
            // The engine memoises "this scope has a model row" inside the
            // transaction that just rolled back, so the memo goes with it.
            try { datatableDbStore.invalidate(scopeKey); } catch { /* best effort */ }
            report.skipped.push({ ref: entity.ref, kind: 'datatable', why: err.message });
        }
    }
}

/**
 * The empty tables the installer asked for, for keys this Blueprint does not
 * carry a table for.
 *
 * Through `installDatatables`, so there is exactly one path in this file that
 * creates a table — one transaction, one quota check, one physical DDL — rather
 * than a second, simpler-looking one that would drift from it.
 *
 * Two things are deliberately NOT shared with a bundled table:
 *
 *   - no stamp. `project_solution_entities` records what a bundled entity
 *     looked like on arrival so a later upgrade can tell edited from pristine.
 *     A table the installer conjured is in no Blueprint, so a stamp under a
 *     made-up ref would offer it updates from a file that never mentions it.
 *   - its own refMap. `{ $ref }` addresses the bundle; a synthetic ref must not
 *     become resolvable, or a manifest could point at one by guessing the name.
 */
async function createRequestedTables(ctx, report) {
    const wanted = (ctx.wiring.resolutions.tables || []).filter(t => t.create === true);
    if (!wanted.length) return;

    const sub = { installed: { datatables: [] }, skipped: [], warnings: [] };
    await installDatatables(
        wanted.map(t => ({ ref: `requested:${t.key}`, key: t.key, name: t.key, description: '', columns: [] })),
        { ...ctx, refMap: new Map(), stamp: async () => {} },
        sub,
    );

    for (const row of sub.installed.datatables) {
        const key = String(row.ref).slice('requested:'.length);
        ctx.wiring.createdForKey.set(key, row.id);
        // `ref: null` is the load-bearing part: this table belongs to the
        // Solution but to no entry in the Blueprint, and a reader (or O4's
        // upgrade client) must be able to tell those apart.
        report.installed.datatables.push({ ref: null, id: row.id, name: row.name, forKey: key });
    }
    for (const row of sub.skipped) {
        report.skipped.push({
            ref: null, kind: 'datatable',
            why: `The empty table "${String(row.ref).slice('requested:'.length)}" you asked for could not be created: ${row.why}`,
        });
    }
    report.warnings.push(...sub.warnings);
}

/**
 * The tables a `datatableKey` may be re-linked to, and which of them this
 * install made itself.
 *
 * The bundle's own tables come first and WIN a key clash. A Blueprint that
 * ships a table called "invoices" means its own copy when one of its automations
 * says `datatableKey: 'invoices'` — binding that step to a pre-existing table
 * of the recipient's instead would quietly point the Solution at somebody
 * else's data on the strength of a slug collision.
 */
function tablesForRebind(bundled, ctx, report) {
    const out = [];
    const byKey = new Set();

    for (const entity of bundled) {
        const id = ctx.refMap.get(entity.ref);
        const key = typeof entity.key === 'string' ? entity.key.trim() : '';
        if (!id || !key || byKey.has(key)) continue;
        byKey.add(key);
        ctx.wiring.freshTableIds.add(id);
        out.push({ id, key, name: entity.name || key });
    }

    for (const row of (ctx.wiring.resolutions.tables || [])) {
        const id = row.create === true ? ctx.wiring.createdForKey.get(row.key) : row.datatableId;
        if (!id) continue;                       // a create that failed; already reported
        if (byKey.has(row.key)) {
            report.warnings.push(
                `This Solution brings its own table for "${row.key}", so the one you picked was not used.`,
            );
            continue;
        }
        byKey.add(row.key);
        // A table THIS install created is as much "shipped with it" as a
        // bundled one, so it gets the same silence: there is nothing for the
        // installer to double-check about a table that did not exist a second
        // ago. A table they PICKED is theirs to check, and stays out of the set.
        if (row.create === true) ctx.wiring.freshTableIds.add(id);
        out.push({ id, key: row.key, name: row.key });
    }

    return out;
}

/**
 * Install the AGENTS.
 *
 * Nothing here re-applies the rights rule: `config.tools[*].actAs` is already
 * `'viewer'` in the file, because capture wrote it down that way and
 * sanitizeManifest hands install a checked copy. What install adds is the two
 * halves it owns —
 *
 *   - the agent is created under the INSTALLER, like every other entity;
 *   - `embed_enabled` is never set, and createAgent has no parameter for it, so
 *     the column's own `DEFAULT FALSE` is what an installed agent gets. An
 *     installed agent is not embeddable until somebody decides it should be.
 *
 * `is_published` and `shared_groups` are left at their defaults for the same
 * reason: an installed agent belongs to whoever installed it and is shared with
 * nobody until they say so.
 */
async function installAgents(entities, ctx, report) {
    if (!entities.length) return;
    const agentStore = require('../../stores/agentStore');
    for (const entity of entities) {
        try {
            const config = (entity.config && typeof entity.config === 'object') ? clone(entity.config) : {};
            // A pipeline release carries the agent's knowledge bases and skills
            // as `$ref` (gallery files drop them). Bases are installed before
            // any agent; a ref with nothing behind it leaves the list, named.
            const { unresolved } = fromRefs('agent', { config }, ctx.refMap);
            for (const u of unresolved) {
                report.warnings.push(`A reference to "${u.ref}" in "${entity.name}" could not be connected — whatever it pointed at was not installed.`);
            }
            // Belt and braces on the one thing that must never arrive wider
            // than it left: whatever the file says, an installed grant acts as
            // whoever uses the agent.
            if (config.tools && typeof config.tools === 'object') {
                for (const key of Object.keys(config.tools)) {
                    if (config.tools[key] && typeof config.tools[key] === 'object') config.tools[key].actAs = 'viewer';
                }
            }
            const created = await agentStore.createAgent(
                entity.name || 'Untitled agent',
                entity.description || '',
                entity.systemPrompt || '',
                ctx.ownerId,
                entity.model || null,
                Array.isArray(entity.starterPrompts) ? entity.starterPrompts : [],
                entity.threadsEnabled !== false,
                entity.copyEnabled !== false,
                entity.workspaceEnabled === true,
                config,
                ctx.organizationId,
                [],                 // shared with nobody
                null,               // and filed under no category
            );
            await agentStore.setAgentProject(created.id, ctx.ownerId, ctx.projectId);
            ctx.refMap.set(entity.ref, created.id);
            await ctx.stamp({ ref: entity.ref, kind: 'agent', entityId: created.id, payload: config });
            report.installed.agents.push({ ref: entity.ref, id: created.id, name: entity.name });
        } catch (err) {
            report.skipped.push({ ref: entity.ref, kind: 'agent', why: err.message });
        }
    }
}

/**
 * Install the KNOWLEDGE BASES, as empty shells.
 *
 * A base arrives with a name, a description, an icon and the surfaces its
 * author allowed — and no documents and no sources, because those are the
 * source organisation's material and its places to fetch from. Whoever installs
 * it fills it with their own, which is also what `duplicate` does and for the
 * same reason.
 *
 * The link into the project goes through the SAME adapter the resources route
 * uses, so the compare-and-swap on `projects.version` applies here too: an
 * install writing the whole array by hand would delete a base a colleague added
 * while it was running.
 */
async function installKnowledgeBases(entities, ctx, report) {
    if (!entities.length) return;
    const kbStore = require('../../stores/knowledgeBases');
    const kbMembership = require('../knowledgeBaseMembership');
    for (const entity of entities) {
        try {
            const created = await kbStore.createKB(
                ctx.ownerId,
                entity.name || 'Untitled knowledge base',
                entity.description || '',
                ctx.organizationId || null,
                {
                    icon: entity.icon || null,
                    // Filed under no category on purpose: a category id names a
                    // row of the source installation, so there is nothing to
                    // carry and nothing to guess.
                    categoryId: null,
                    sourceKind: 'manual',
                    ...(Array.isArray(entity.usageContexts) ? { usageContexts: entity.usageContexts } : {}),
                },
            );
            // Attaching by the owner's own hand: they created the base a moment
            // ago, so the read check the adapter applies passes by
            // construction. It still goes through the adapter rather than
            // around it — an install must not be the one path that writes
            // `knowledge_base_ids` without the compare-and-swap.
            const filed = await kbMembership.setKnowledgeBaseProject(created.id, ctx.ownerId, ctx.projectId,
                { req: ctx.req, projectId: ctx.projectId, ...writeOpts(ctx) });
            if (!filed) {
                // Said out loud rather than left as a base that exists and is
                // in no project. Reachable when the caller had no request to
                // check against — an install run from a script, say.
                report.warnings.push(`"${entity.name}" was created but could not be filed into the Solution. Add it to the project by hand.`);
            }
            ctx.refMap.set(entity.ref, created.id);
            await ctx.stamp({ ref: entity.ref, kind: 'knowledge_base', entityId: created.id, payload: { name: entity.name } });
            report.installed.knowledgeBases.push({ ref: entity.ref, id: created.id, name: entity.name });
        } catch (err) {
            report.skipped.push({ ref: entity.ref, kind: 'knowledge_base', why: err.message });
        }
    }
}

/**
 * The ids of a skill's `{ $ref }` list: only the refs, resolved. A bare id
 * names a row of the installation the file came from, so it is not a pointer
 * here and never survives; a ref with nothing behind it leaves the list and is
 * named in `unresolved`.
 */
function resolvedRefList(list, refMap, unresolved) {
    const holder = { knowledge_base_ids: (Array.isArray(list) ? list : []).filter(isRef) };
    const { unresolved: missed } = fromRefs('skill', holder, refMap);
    for (const m of missed) unresolved.push(m.ref);
    return holder.knowledge_base_ids;
}

/**
 * The fields a skill is written with (camelCase, as createSkill and
 * writeManagedSkill take them), from its manifest entry.
 *
 * Each body facet is sent once: the structured form when there is one (the
 * store regenerates the text from it), the text form otherwise (the store
 * parses it). Sending both would let an empty structured column blank a
 * written-out text. Links to a base or an automation travel as `$ref` and are
 * resolved against `refMap`; step references the same. `sharedGroups`,
 * `isShared` and `enabledIntegrations` are never taken from a file.
 *
 * @param {object} entity
 * @param {Map<string, string>} refMap
 * @param {string[]} [unresolved]  collects every `$ref` that had no target
 */
function skillFieldsOf(entity, refMap, unresolved = []) {
    const fields = {
        name: String(entity.name || 'Untitled skill'),
        description: typeof entity.description === 'string' ? entity.description : '',
        instructions: typeof entity.instructions === 'string' ? entity.instructions : '',
        icon: typeof entity.icon === 'string' && entity.icon ? entity.icon : undefined,
        dynamicActivation: entity.dynamic_activation === true,
        knowledgeBaseIds: resolvedRefList(entity.knowledge_base_ids, refMap, unresolved),
        allowedAutomationIds: resolvedRefList(entity.allowed_automation_ids, refMap, unresolved),
        automationId: resolvedRefList(isRef(entity.automation_id) ? [entity.automation_id] : [], refMap, unresolved)[0] || null,
    };
    const steps = (Array.isArray(entity.steps) ? entity.steps : []).map((step) => {
        if (!step || typeof step !== 'object' || !Array.isArray(step.refs)) return step;
        const refs = [];
        for (const r of step.refs) {
            if (!r || !isRef(r.id)) continue;                 // a bare id names another installation's row
            const real = refMap.get(r.id.$ref);
            if (typeof real === 'string') refs.push({ ...r, id: real });
            else unresolved.push(r.id.$ref);
        }
        return { ...step, refs };
    });
    for (const [structured, text, camel, value] of [
        ['steps', 'workflow', 'steps', steps],
        ['rules_v2', 'rules', 'rulesV2', entity.rules_v2],
        ['examples_v2', 'examples', 'examplesV2', entity.examples_v2],
    ]) {
        if (Array.isArray(value) && value.length) fields[camel] = clone(value);
        else if (typeof entity[text] === 'string' && entity[text].trim()) fields[text] = entity[text];
        else if (entity[structured] !== undefined && !Array.isArray(entity[structured])) fields[camel] = entity[structured];
    }
    if (entity.output_schema && typeof entity.output_schema === 'object') fields.outputSchema = clone(entity.output_schema);
    for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
    return fields;
}

/**
 * Install the SKILLS.
 *
 * Gallery path: the skill is created under the installer, unshared and with no
 * connected app switched on (`enabled_integrations` is a requirement, never a
 * grant), then filed through the membership registry's `setProject`, the one
 * way a skill enters a Solution.
 *
 * Stage path (`ctx.managedWrite`): a stage skill has no live copy and is
 * written in the deployment's commit by `skillStore.writeManagedSkill`, so
 * nothing is written here. The row is COMPUTED: an id is allocated now so
 * automations and agents can point at it, and `report.computed.skills` carries
 * `{ ref, id, fields }`, ready for the commit. `skillFieldsOf` recomputes the
 * fields once every part of the release has an id.
 */
async function installSkills(entities, ctx, report) {
    if (!entities.length) return;
    const skillStore = require('../../stores/skillStore');
    const staged = !!ctx.managedWrite;
    for (const entity of entities) {
        try {
            const unresolved = [];
            const fields = skillFieldsOf(entity, ctx.refMap, unresolved);
            if (!staged) {
                for (const ref of new Set(unresolved)) {
                    report.warnings.push(`A reference to "${ref}" in the skill "${entity.name}" could not be connected — whatever it pointed at was not installed.`);
                }
            }
            let id;
            if (staged) {
                id = crypto.randomUUID();
                report.computed = report.computed || {};
                (report.computed.skills = report.computed.skills || []).push({ ref: entity.ref, id, fields });
            } else {
                const created = await skillStore.createSkill({
                    ...fields, orgId: ctx.organizationId || null, userId: ctx.ownerId,
                    isShared: false, sharedGroups: [], enabledIntegrations: [],
                });
                id = created.id;
                const filed = await require('../membership').getKind('skill')
                    .setProject(id, ctx.ownerId, ctx.projectId, { projectId: ctx.projectId, req: ctx.req, ...writeOpts(ctx) });
                if (!filed) report.warnings.push(`The skill "${entity.name}" was created but could not be filed into the Solution. Add it to the project by hand.`);
            }
            ctx.refMap.set(entity.ref, id);
            await ctx.stamp({ ref: entity.ref, kind: 'skill', entityId: id, payload: fields });
            (report.installed.skills ||= []).push({ ref: entity.ref, id, name: entity.name });
        } catch (err) {
            report.skipped.push({ ref: entity.ref, kind: 'skill', why: err.message });
        }
    }
}

/** The fields a template is written with (camelCase), from its manifest entry. */
function templateFieldsOf(entity) {
    return {
        name: String(entity.name || 'Untitled document'),
        docType: typeof entity.doc_type === 'string' && entity.doc_type ? entity.doc_type : 'document',
        kind: ['template', 'section', 'document'].includes(entity.kind) ? entity.kind : 'template',
        description: typeof entity.description === 'string' ? entity.description : '',
        bodyHtml: typeof entity.body_html === 'string' ? entity.body_html : '',
        css: typeof entity.css === 'string' ? entity.css : '',
        settings: entity.settings && typeof entity.settings === 'object' && !Array.isArray(entity.settings) ? clone(entity.settings) : {},
    };
}

/**
 * Install the DOCUMENT TEMPLATES.
 *
 * A template is a document row owned by the installer, private and filed into
 * the Solution through `solution_project_id` (the membership registry's
 * `document_template` kind), never as project content. The revision a
 * `fill_document` step is pinned to is recorded in `ctx.templateVersions`
 * (template id → revision id): `patchReferences` and `resolveRefs` write it
 * onto the automations.
 *
 * Gallery path: `createDocument`, then filed through the registry. Stage path
 * (`ctx.managedWrite`): the template must exist in the stage before automations
 * resolve against it, so it is written with the deployment's capability by
 * `writeManagedTemplate` (one transaction, owned by the run-as user, filed at
 * INSERT) and the revision it wrote is the pin. A later release's content
 * reaches an existing template through `createVersionRow`, which the stage
 * engine calls itself and records in `ctx.templateVersions`.
 */
async function installDocumentTemplates(entities, ctx, report) {
    if (!entities.length) return;
    const staged = !!ctx.managedWrite;
    for (const entity of entities) {
        try {
            const fields = templateFieldsOf(entity);
            if (fields.docType === 'page') {
                report.skipped.push({ ref: entity.ref, kind: 'document', why: 'A page is never a Solution template.', permanent: true });
                continue;
            }
            let id;
            let versionId;
            if (staged) {
                const withTransaction = ctx.deps?.withTransaction || require('../../db').withTransaction;
                const out = await withTransaction((client) => require('../../stores/document/solutionTemplates').writeManagedTemplate(
                    client,
                    { ownerId: ctx.ownerId, orgId: ctx.organizationId || null, projectId: ctx.projectId, fields },
                    { managedWrite: ctx.managedWrite },
                ));
                ({ id, versionId } = out);
            } else {
                const created = await require('../../stores/documentStore').createDocument({
                    userId: ctx.ownerId, visibility: 'private', ...fields,
                });
                id = created.id;
                versionId = created.versionId;
                const filed = await require('../membership').getKind('document_template')
                    .setProject(id, ctx.ownerId, ctx.projectId, { projectId: ctx.projectId, req: ctx.req, ...writeOpts(ctx) });
                if (!filed) report.warnings.push(`The template "${entity.name}" was created but could not be filed into the Solution. Add it to the project by hand.`);
            }
            ctx.refMap.set(entity.ref, id);
            if (versionId) ctx.templateVersions.set(id, versionId);
            await ctx.stamp({ ref: entity.ref, kind: 'document', entityId: id, payload: fields });
            (report.installed.documents ||= []).push({ ref: entity.ref, id, name: entity.name, ...(versionId ? { versionId } : {}) });
        } catch (err) {
            report.skipped.push({ ref: entity.ref, kind: 'document', why: err.message });
        }
    }
}

/**
 * The bridge grants an installed page gets: the ones this install can vouch
 * for, and nothing else. See the module header for why a granted tool is
 * authority over the installer's account rather than a property of the page.
 *
 * `ai` is written EXPLICITLY rather than omitted. Leaving it out would work
 * today — updateBridgeGrants treats an absent key as "keep what is there", and
 * a page created a moment ago carries the store's default — but that makes the
 * safety of an install depend on a default two modules away staying what it is.
 * Written out, the install says what it grants.
 *
 * An automation grant survives only if the file pointed at an automation INSIDE
 * this bundle with `{ $ref }` and that automation actually landed. A bare id is
 * not a reference to anything this bundle contains: it names a row in the
 * installation the file came from, so it is dropped. A `$ref` whose target did
 * not install is dropped too, and NAMED through `unresolved` — the page ends up
 * with one grant fewer, never with a grant it cannot explain.
 */
function safeInstallGrants(entity, refMap, unresolved = []) {
    const { DEFAULT_BRIDGE_GRANTS } = require('../../stores/webpage/bridgeGrants');
    const asked = (entity && typeof entity.bridgeGrants === 'object' && entity.bridgeGrants) || {};

    const automations = [];
    for (const grant of (Array.isArray(asked.automations) ? asked.automations : [])) {
        const pointer = grant && grant.automationId;
        const ref = (pointer && typeof pointer === 'object' && typeof pointer.$ref === 'string')
            ? pointer.$ref : null;
        if (!ref) continue;                       // a bare id names another installation's row
        const real = refMap.get(ref);
        if (typeof real !== 'string') { unresolved.push(ref); continue; }
        automations.push({
            automationId: real,
            ...(grant.label ? { label: String(grant.label) } : {}),
        });
    }

    // Table grants (F14): the same rule as automations. Only a table this bundle
    // carries, by `$ref`, resolved to the copy this install made. Mode and
    // columns travel; PUBLIC columns do not: anonymous read access to the
    // installer's table is the table-shaped twin of public AI, and an install
    // never switches that on for anybody.
    const tables = [];
    for (const grant of (Array.isArray(asked.tables) ? asked.tables : [])) {
        const pointer = grant && grant.datatableId;
        const ref = (pointer && typeof pointer === 'object' && typeof pointer.$ref === 'string') ? pointer.$ref : null;
        if (!ref) continue;                       // a bare id or a hole names nothing in this bundle
        const real = refMap.get(ref);
        if (typeof real !== 'string') { unresolved.push(ref); continue; }
        tables.push({
            datatableId: real,
            mode: grant.mode === 'readwrite' ? 'readwrite' : 'read',
            columns: Array.isArray(grant.columns) ? grant.columns.filter(c => typeof c === 'string') : [],
            publicColumns: [],
        });
    }

    // The page's agent: one in this bundle, by `$ref`, or none.
    let agent = null;
    const ap = asked.agent && asked.agent.agentId;
    if (ap && typeof ap === 'object' && typeof ap.$ref === 'string') {
        const real = refMap.get(ap.$ref);
        if (typeof real === 'string') agent = { agentId: real };
        else unresolved.push(ap.$ref);
    }

    return {
        ai: { ...DEFAULT_BRIDGE_GRANTS.ai },
        automations,
        // A tool name IS the grant: the bridge runs as the page's author, so
        // carrying one over would hand the installer's Gmail to a file.
        integrations: [],
        tables,
        agent,
    };
}

/**
 * What a Blueprint ASKED a page to be allowed to do, that an install refuses to
 * grant — as rows somebody can act on.
 *
 * This is the other half of `safeInstallGrants`: dropping a request silently
 * would turn "we do not grant this for you" into "this Solution is broken and
 * nobody said why". The install wizard lists these in its Connect step and the
 * installer re-assigns them by hand, with the connection status in front of
 * them; the post-install report carries the same rows for a file install.
 *
 * Run over the RAW manifest, never the checked copy: sanitizeManifest strips
 * every `ai.public*` key before install sees it, and showing what was stripped
 * is the entire point.
 *
 * `publicSpendCapUsd` travels on the row because a request to enable anonymous
 * AI is not the same size at $2 and at $50, and the person deciding should see
 * which one they were asked for.
 */
function collectGrantRequires(manifest) {
    const entities = manifest?.solution?.entities || {};
    const declared = new Set();
    for (const list of Object.values(entities)) {
        for (const e of (Array.isArray(list) ? list : [])) {
            if (e && typeof e.ref === 'string') declared.add(e.ref);
        }
    }

    const rows = [];
    for (const entity of (Array.isArray(entities.webpages) ? entities.webpages : [])) {
        const asked = (entity && typeof entity.bridgeGrants === 'object' && entity.bridgeGrants) || {};
        const on = { ref: entity?.ref || null, name: entity?.name || '' };

        for (const grant of (Array.isArray(asked.integrations) ? asked.integrations : [])) {
            if (grant && typeof grant.tool === 'string' && grant.tool) {
                // fixedArgs deliberately NOT echoed: sanitizeManifest removes
                // them because they can carry a path, an id or a token, and a
                // row that displayed them would put them back on a screen.
                rows.push({ ...on, kind: 'integration', tool: grant.tool, ...(grant.label ? { label: String(grant.label) } : {}) });
            }
        }

        for (const grant of (Array.isArray(asked.automations) ? asked.automations : [])) {
            const pointer = grant && grant.automationId;
            const ref = (pointer && typeof pointer === 'object' && typeof pointer.$ref === 'string') ? pointer.$ref : null;
            // In-bundle refs are the one thing install DOES carry, so they are
            // not a require. Everything else is: a bare id, or a ref the file
            // does not contain.
            if (ref && declared.has(ref)) continue;
            rows.push({
                ...on, kind: 'automation',
                ...(ref ? { ref$: ref } : {}),
                ...(typeof pointer === 'string' ? { automationId: pointer } : {}),
                ...(grant?.label ? { label: String(grant.label) } : {}),
            });
        }

        // Any `public*` flag the file switched ON. Matched by SHAPE, like
        // manifest.stripNeverInstallable — a `publicSomethingNew` added to
        // bridgeGrants next year is reported by the rule written before it
        // existed. A cap or a tier alone opens no door, so it is carried on the
        // row rather than being a row of its own.
        const ai = (asked.ai && typeof asked.ai === 'object') ? asked.ai : null;
        if (ai && Object.entries(ai).some(([k, v]) => /^public/.test(k) && v === true)) {
            const flags = {};
            for (const [k, v] of Object.entries(ai)) if (/^public/.test(k)) flags[k] = v;
            rows.push({ ...on, kind: 'public_ai', flags });
        }
    }
    return rows;
}

/**
 * The second pass: with every id known, put the references back.
 *
 * Written through the stores' own save paths, never raw SQL — the same
 * discipline templateInstall keeps, so an installed entity goes through
 * whatever validation and stamping a hand-edited one would.
 */
async function patchReferences(manifest, ctx, report, { refs = null } = {}) {
    const entities = manifest.solution.entities;
    const unresolved = [];
    // An upgrade patches only the parts it ADDED (F11); the parts it replaced
    // resolve their own references on the way in.
    const mine = (entity) => (!refs || refs.has(entity.ref)) && ctx.refMap.has(entity.ref);

    for (const entity of (entities.apps || []).filter(mine)) {
        const id = ctx.refMap.get(entity.ref);
        try {
            const { definition } = resolveRefs('app', { definition: clone(entity.definition) }, ctx.refMap, unresolved);
            await require('../../stores/studioAppStore').saveDefinition(id, ctx.ownerId, definition, writeOpts(ctx));
        } catch (err) {
            report.warnings.push(`Could not connect the references inside "${entity.name}": ${err.message}`);
        }
    }

    for (const entity of (entities.automations || []).filter(mine)) {
        const id = ctx.refMap.get(entity.ref);
        if (!JSON.stringify(entity.definition).includes('"$ref"')) continue;      // nothing to put back
        try {
            const live = await require('../../stores/automationStore').getAutomation(id);
            // The stored copy: its step ids are the ones this install chose.
            const { definition } = resolveRefs('automation', { definition: clone(live.definition) }, ctx.refMap, unresolved, ctx.templateVersions);
            // goLive: the resolved references are part of the installed
            // automation, not a pending edit (handoff 5 live split). An automation
            // that never ran stays a draft: the store moves a live copy only
            // on an automation that has one (lifecycle LIVE_INVARIANT_SQL).
            await require('../../stores/automationStore').updateAutomation(id, { definition }, ctx.ownerId, { goLive: true, ...writeOpts(ctx) });
        } catch (err) {
            report.warnings.push(`Could not connect the references inside "${entity.title}": ${err.message}`);
        }
    }

    for (const entity of (entities.webpages || []).filter(mine)) {
        const id = ctx.refMap.get(entity.ref);
        try {
            await require('../../stores/webpageStore').updateBridgeGrants(
                id, ctx.ownerId, safeInstallGrants(entity, ctx.refMap, unresolved), writeOpts(ctx),
            );
        } catch (err) {
            report.warnings.push(`Could not set what "${entity.name}" is allowed to call: ${err.message}`);
        }
        const publicAsked = (Array.isArray(entity?.bridgeGrants?.tables) ? entity.bridgeGrants.tables : [])
            .some(g => Array.isArray(g?.publicColumns) && g.publicColumns.length);
        if (publicAsked) {
            report.warnings.push(`"${entity.name}" asks to show table columns to anonymous visitors. An install never grants that: open the page and choose the public columns yourself.`);
        }
    }

    for (const ref of [...new Set(unresolved)]) {
        report.warnings.push(`A reference to "${ref}" could not be connected — whatever it pointed at was not installed.`);
    }
}

/**
 * Keep the installer's resolutions as `solution_bindings` rows on the new
 * project (F3): an upgrade reads them back and fills the same holes. A table
 * the installer asked to have CREATED is kept as the table that was made.
 * Never fatal: the install already applied them; without the rows only a
 * later upgrade forgets them, and the report says so.
 */
async function persistResolutions(ctx, report) {
    if (!ctx.wiring) return;
    const rows = resolutionsToBindings(ctx.wiring.resolutions, {
        createdForKey: ctx.wiring.createdForKey,
        // Connections and approvers: only the ones that landed on a step of a
        // automation that was installed. One that missed was said once, here.
        applied: Array.isArray(ctx.wiring.applied) ? ctx.wiring.applied : null,
    });
    if (!rows.length) return;
    try {
        const store = ctx.deps?.bindings || require('../../stores/solutionStageStore');
        await store.upsertBindings(ctx.projectId, rows, ctx.ownerId);
    } catch (err) {
        report.warnings.push(`Your choices were applied, but could not be saved for later updates, so an update will leave those steps unconnected again: ${err.message}`);
    }
}

/** The installer per part kind, for `installOne`. */
const INSTALLERS = Object.freeze({
    automation: (...a) => installAutomations(...a),
    block: (...a) => installAutomations(...a),
    layer: (...a) => installAutomations(...a),
    app: (...a) => installApps(...a),
    webpage: (...a) => installWebpages(...a),
    datatable: (...a) => installDatatables(...a),
    agent: (...a) => installAgents(...a),
    knowledge_base: (...a) => installKnowledgeBases(...a),
    skill: (...a) => installSkills(...a),
    document: (...a) => installDocumentTemplates(...a),
});

/**
 * Install ONE part through the same path a whole Blueprint takes (inactive on
 * arrival, one owner, filed into `ctx.projectId`, stamp collected). The stage
 * engine creates a missing part this way, with a ctx from `makeInstallCtx`
 * (`rekey: false`, the stage's scope and key rule, run-as owner, stage
 * project, and the deployment's `managedWrite`: without it the store guards
 * refuse to file a part into a stage, and the part lands in `report.skipped`
 * as 409 managed_part). Returns the new id, or null when the part was skipped
 * (the reason is in `report.skipped`).
 *
 * @param {string} kind  automation | block | layer | app | webpage | datatable | agent | knowledge_base | skill | document
 *
 * With `ctx.managedWrite` a `skill` is only COMPUTED (its id is allocated and
 * `report.computed.skills` gets `{ ref, id, fields }`; the deployment's commit
 * writes the row), and a `document` template is created in the stage with the
 * revision it is pinned to in `ctx.templateVersions`.
 */
async function installOne(kind, entity, ctx, report) {
    const install = INSTALLERS[kind];
    if (!install) throw new TypeError(`installOne: no installer for kind '${kind}'`);
    report.installed = report.installed || {};
    for (const list of ['automations', 'apps', 'webpages', 'datatables', 'agents', 'knowledgeBases', 'skills', 'documents']) {
        if (!Array.isArray(report.installed[list])) report.installed[list] = [];
    }
    for (const list of ['skipped', 'warnings', 'resolved']) if (!Array.isArray(report[list])) report[list] = [];
    if (!report.computed || typeof report.computed !== 'object') report.computed = {};
    await install([entity], ctx, report);
    return ctx.refMap.get(entity.ref) || null;
}

/**
 * Install a Blueprint as a new Solution.
 *
 * @param {object}   input
 * @param {object}   input.manifest
 * @param {string}   input.ownerId          every entity is created under this person
 * @param {string}   [input.organizationId]
 * @param {string}   [input.name]           override the Blueprint's own name
 * @param {string}   [input.blueprintId]    the gallery Blueprint this came
 *   from, when the SERVER resolved one. Recorded on the project so the overview
 *   can show it under "Installed" and tell the installer a newer version
 *   exists. A file install has none here and falls back to what the file claims
 *   about itself — see provenanceOf for the difference between the two, which
 *   is the difference between established and asserted.
 * @param {string}   [input.blueprintOrgId] the organisation of that resolved
 *   Blueprint, read off the gallery row by the route. Never taken from the
 *   file when this is set, and never a grant either way.
 * @param {Function} [input.can]            capability predicate; defaults to permissive
 * @param {object}   [input.req]            the installing request. Only the
 *   knowledge-base kind needs it, and only to answer "may this person read this
 *   base" — see projects/knowledgeBaseMembership.js. Without it a base is still
 *   created and the report says it could not be filed into the project.
 * @param {object}   [input.resolutions]    what the INSTALLER supplies for the
 *   holes scrub.js left: `{ tables, connections, approvers }`. Normalised
 *   before anything reads it, so an unrecognised key contributes nothing —
 *   see projects/packaging/resolutions.js. What was used is kept as
 *   `solution_bindings` rows on the new project, so an upgrade fills the same
 *   holes the same way (F3).
 * @param {object}   [input.deps]           `{ bindings }`: the store the
 *   resolutions are kept in (default stores/solutionStageStore).
 */
async function installBlueprint({
    manifest, ownerId, organizationId = null, name = null, blueprintId = null,
    blueprintOrgId = null, can = () => true, req = null, resolutions = null, deps = {},
} = {}) {
    if (!ownerId) return { ok: false, errors: ['An installer is required.'] };

    const checked = sanitizeManifest(manifest);
    if (!checked.ok) return { ok: false, errors: checked.errors };

    const solution = checked.manifest.solution;
    const projectStore = require('../../stores/projectStore');

    const report = {
        installed: { automations: [], apps: [], webpages: [], datatables: [], agents: [], knowledgeBases: [], skills: [], documents: [] },
        computed: {},
        skipped: [],
        warnings: [],
        // What the file asked a page to be allowed to do and this install would
        // not grant. Read off the RAW manifest, before sanitizeManifest strips
        // the `ai.public*` keys — see collectGrantRequires.
        grantRequires: collectGrantRequires(manifest),
        // Which of the installer's own choices were actually used. Empty is the
        // honest answer for an install that was handed none, and for one whose
        // choices all missed — the `warnings` say which of the two it was.
        resolved: [],
    };

    // Waar dit vandaan komt, uit het GECONTROLEERDE manifest — het herkomstblok
    // is daar al genormaliseerd, dus hier wordt geen ruw bestandsveld meer
    // aangeraakt. De organisatie van het PROJECT blijft die van de installateur
    // (`organizationId` hieronder): geen bestand verhuist zichzelf naar een
    // andere org door dat op te schrijven.
    const claimVerified = blueprintId
        ? false
        : await verifyClaimedBlueprint({
            claimedId: readSource(checked.manifest).blueprintId,
            solutionKey: solution.key,
        });
    const provenance = provenanceOf({ blueprintId, blueprintOrgId, manifest: checked.manifest, claimVerified });

    // The project first, so every entity below is stamped at INSERT.
    let project;
    try {
        project = await projectStore.createProject({
            name: name || solution.name || 'Installed Solution',
            description: solution.description || '',
            customInstructions: solution.customInstructions || '',
            color: solution.color || undefined,
            icon: solution.icon || undefined,
            ownerId,
            organizationId,
            // An installed Blueprint is a Studio Solution, never a
            // collaborative project: it lists under Solutions only.
            kind: 'solution',
            ...provenance,
        });
    } catch (err) {
        return { ok: false, errors: [`The Solution could not be created: ${err.message}`] };
    }

    const ctx = makeInstallCtx({
        ownerId, organizationId, projectId: project.id, can, req, deps,
        installedVersion: versionOf(solution),
        // Everything an automation needs to arrive WIRED. An upgrade rebuilds it
        // from the bindings this install saves below (persistResolutions).
        wiring: {
            resolutions: normalizeResolutions(resolutions),
            tables: [],                 // filled in below, before any automation
            freshTableIds: new Set(),   // tables this install made itself
            createdForKey: new Map(),
            applied: [],                // connection/approver rows that landed (persistResolutions)
        },
    });

    // Tables and knowledge bases first: they are what other entities point AT,
    // and nothing points back at an automation from them.
    await installDatatables(solution.entities.datatables || [], ctx, report);
    await installKnowledgeBases(solution.entities.knowledgeBases || [], ctx, report);
    await installDocumentTemplates(solution.entities.documents || [], ctx, report);
    await createRequestedTables(ctx, report);
    ctx.wiring.tables = tablesForRebind(solution.entities.datatables || [], ctx, report);
    await installAutomations(solution.entities.automations || [], ctx, report);
    await installApps(solution.entities.apps || [], ctx, report);
    await installWebpages(solution.entities.webpages || [], ctx, report);
    // Skills after the automations and bases they link to, before the agents that attach them.
    await installSkills(solution.entities.skills || [], ctx, report);
    await installAgents(solution.entities.agents || [], ctx, report);
    await patchReferences(checked.manifest, ctx, report);
    await persistResolutions(ctx, report);
    // Last: every reference and every resolution is in place, so the hash is
    // of what the entity IS, and an untouched one reads as pristine (F2).
    await stampAll(ctx, report);

    for (const requirement of solution.requires || []) {
        report.warnings.push(`This Solution needs ${requirement.count} ${requirement.kind}(s) supplying before it will work.`);
    }

    // Said out loud, once per page, so an install that went through the plain
    // button rather than the wizard still tells somebody what is NOT wired up.
    // The rows themselves travel on `report.grantRequires`.
    // Keyed by REF, so two pages that happen to share a name each get their own
    // sentence; named by whichever of the two a reader would recognise.
    const askedPerPage = new Map();
    for (const row of report.grantRequires) {
        const key = row.ref || row.name || '';
        const seen = askedPerPage.get(key);
        askedPerPage.set(key, { label: row.name || row.ref || 'A page', n: (seen?.n || 0) + 1 });
    }
    for (const { label, n } of askedPerPage.values()) {
        report.warnings.push(
            `"${label}" asks to be allowed to do ${n} thing(s) — a tool, an automation elsewhere, or public AI. An install never grants those on your behalf: open the page and grant what it should have.`,
        );
    }

    return { ok: true, projectId: project.id, report };
}

module.exports = {
    installBlueprint,
    // Reused by upgrade for the entities a newer Blueprint ADDS — creating one
    // during an upgrade and creating one during an install are the same act,
    // and two implementations of it would drift on the details that matter
    // (inactive on arrival, one owner, filed into the project, stamped).
    installAutomations, installApps, installWebpages, patchReferences, installHashOf,
    installDatatables, installAgents, installKnowledgeBases, installSkills, installDocumentTemplates,
    // What a skill and a template are written with, and the pin of a fill_document step.
    skillFieldsOf, templateFieldsOf, pinTemplateVersions,
    // One part at a time and the deferred stamp pass: the stage engine's
    // prepare creates missing parts with these, under its own ctx.
    makeInstallCtx, installOne, stampAll, resolveRefs, applyResolutionsTo,
    // The two halves of "bridge grants are requires": what an install writes,
    // and what it refuses to write and shows instead. The install wizard reads
    // the second one to build its Connect step.
    safeInstallGrants, collectGrantRequires,
    // The other direction — what the INSTALLER supplies. Exported for the tests
    // that pin the "a resolution fills a hole, it never re-points" rule.
    tablesForRebind, createRequestedTables,
    // Waar een installatie vandaan zegt te komen: vastgesteld door de server,
    // of beweerd door het bestand. Puur, dus de vijandige gevallen zijn op
    // zichzelf te toetsen.
    provenanceOf,
    verifyClaimedBlueprint,
};
