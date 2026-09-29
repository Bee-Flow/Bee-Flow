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
 * nobody can un-delete a routine an upgrade decided was obsolete.
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

function hashOf(payload) {
    const { hashDefinition } = require('../../appStudio/templateUpgrade');
    return hashDefinition(payload);
}

/**
 * The kinds an upgrade may REPLACE, and the reason the other two are absent.
 *
 * A newer Blueprint replacing a routine, an app, a page or an agent rewrites a
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

/** Write a replacement entity through the store's own save path. */
function clone(v) {
    try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v ?? null)); }
}

async function replaceEntity(kind, entityId, entity, ctx, report) {
    const { rewriteRefs } = require('./manifest');
    const unresolved = [];
    try {
        if (kind === 'automation') {
            const definition = rewriteRefs(entity.definition, ctx.refMap, unresolved);
            // goLive: a package upgrade replaces what RUNS, not a draft the
            // owner still has to publish (handoff 5 live split).
            await require('../../stores/automationStore').updateAutomation(entityId, { definition }, ctx.ownerId, { goLive: true });
            await ctx.stamp({ ref: entity.ref, kind, entityId, payload: definition });
        } else if (kind === 'app') {
            const definition = rewriteRefs(entity.definition, ctx.refMap, unresolved);
            await require('../../stores/studioAppStore').saveDefinition(entityId, ctx.ownerId, definition);
            await ctx.stamp({ ref: entity.ref, kind, entityId, payload: definition });
        } else if (kind === 'webpage') {
            const files = entity.files || {};
            for (const [slot, content] of [['index.html', files.html], ['style.css', files.css], ['script.js', files.js]]) {
                if (content !== undefined) await require('../../stores/webpageStore').writeSlot(ctx.ownerId, entityId, slot, content);
            }
            // Een upgrade herschrijft alle drie de slots, dus hij kan een
            // `<bf-table source="…">` net zo goed WEGHALEN als toevoegen —
            // en de dependents-index is delete-then-insert, dus zonder
            // reconcile blijft de rij van de VORIGE versie staan. De
            // tabel-eigenaar krijgt dan een 409 over een pagina die zijn tabel
            // niet meer gebruikt. Zelfde reden als op het install-pad, en hier
            // sterker: daar is de pagina nieuw, hier heeft ze al een index.
            require('../../core/webpages/webpageUsageSync').reconcileWebpageUsageDetached(entityId);
            await ctx.stamp({ ref: entity.ref, kind, entityId, payload: files });
        } else if (kind === 'agent') {
            // Through the store's own save path, and with the authority rule
            // re-applied on the way in: an UPDATE is as much a way to widen a
            // grant as a create is, so `actAs` is written to 'viewer' here too
            // rather than trusted from the file.
            const agentStore = require('../../stores/agentStore');
            const live = await agentStore.getAgent(entityId);
            if (!live) throw new Error('that agent is gone');
            const config = rewriteRefs(clone(entity.config || {}), ctx.refMap, unresolved);
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
                // embed_enabled: an upgrade never switches embedding on.
                false,
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
            await ctx.stamp({ ref: entity.ref, kind, entityId, payload: config });
        }
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
 */
async function applyUpgrade({ projectId, manifest, ownerId, organizationId = null, can = () => true, req = null } = {}) {
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

    const report = {
        replaced: [], skipped: plan.skip, missing: plan.missing,
        added: { automations: [], apps: [], webpages: [], datatables: [], agents: [], knowledgeBases: [] },
        failed: [], warnings: [],
    };

    // Existing entities keep their real ids, so a reference to one of them
    // resolves to what is already installed rather than to a fresh copy.
    const refMap = new Map([...stamps.entries()].map(([ref, s]) => [ref, s.entityId]));

    const {
        installAutomations, installApps, installWebpages,
        installDatatables, installAgents, installKnowledgeBases, installHashOf,
    } = require('./install');
    const stamp = async ({ ref, kind, entityId, payload }) => {
        try {
            await require('../../stores/blueprintStore').stampEntity({
                projectId, ref, kind, entityId,
                installHash: installHashOf(payload),
                installedVersion: manifest.solution.version || 1,
            });
        } catch (err) {
            report.warnings.push(`Could not record the new state of "${ref}": ${err.message}`);
        }
    };
    // `wiring: null` is a decision, not an omission. Install builds one from
    // the wizard's `resolutions` — which table, which credential, who approves.
    // An upgrade has no wizard in front of it: nobody was asked, so nothing is
    // filled in, and a newly added routine's unbound datatable step stays
    // unbound rather than being re-linked on somebody's behalf.
    const ctx = { ownerId, organizationId, projectId, refMap, can, stamp, req, wiring: null };

    // Additions first, so a replacement that references a newly-added entity
    // finds a real id waiting for it.
    const addedRefs = new Set(plan.add.map(a => a.ref));
    const addReport = { installed: report.added, skipped: [], warnings: [] };
    const onlyAdded = (list) => (list || []).filter(e => addedRefs.has(e.ref));
    await installDatatables(onlyAdded(entities.datatables), ctx, addReport);
    await installKnowledgeBases(onlyAdded(entities.knowledgeBases), ctx, addReport);
    await installAutomations(onlyAdded(entities.automations), ctx, addReport);
    await installApps(onlyAdded(entities.apps), ctx, addReport);
    await installWebpages(onlyAdded(entities.webpages), ctx, addReport);
    await installAgents(onlyAdded(entities.agents), ctx, addReport);
    report.failed.push(...addReport.skipped);
    report.warnings.push(...addReport.warnings);

    const byRef = new Map();
    for (const [kind, list] of PLAN_LISTS(entities)) {
        for (const e of (list || [])) byRef.set(e.ref, { kind, entity: e });
    }
    for (const item of plan.replace) {
        const found = byRef.get(item.ref);
        if (found) await replaceEntity(found.kind, item.entityId, found.entity, ctx, report);
    }

    for (const m of plan.missing) {
        report.warnings.push(`"${m.ref}" was installed once and is gone now, so this update left it alone — deleting it was a decision, not damage.`);
    }

    return { ok: true, toVersion: planned.toVersion, report };
}

module.exports = { planUpgrade, applyUpgrade, isNewer, currentPayload, REPLACEABLE_KINDS };
