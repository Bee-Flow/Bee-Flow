/**
 * Read everything a Solution's graph is drawn from, and SAY what could not be
 * read.
 *
 * The loader behind GET /:id/graph, GET /:id/completeness, GET /summary, Studio
 * Home's attention list and the server-side publish gate (POST
 * /:id/package/export with `save: true`). It lived in routes/projects.js; it
 * moved here so the publish gate in routes/projects/packaging.js and the
 * release engine can ask the SAME question without requiring a router.
 *
 * The old shape of this loader returned `[]` for a store it could not reach,
 * which is indistinguishable from "this Solution has no agents". The Content
 * listing already had the honest convention — `null` = unavailable, `[]` =
 * none (see GET /:id/resources) — and this is the same rule applied here: a
 * kind that could not be read is NAMED in `unavailable`, the graph is drawn
 * from what IS there, and `complete` says whether the picture is whole. A
 * publish button that unlocks because half the Solution silently failed to
 * load is the failure this convention exists to prevent.
 *
 * Three reads can fail INSIDE a kind, and each is counted rather than dropped:
 *   - an app's full definition (the listing gives meta only) — a missing one
 *     used to delete the app from the graph entirely: node, edges AND problems;
 *   - an agent's config, which is where its wiring lives, same story;
 *   - a knowledge base's sources, which is where "every meeting tagged X" is.
 *
 * The existence pass is ALL-OR-NOTHING for the same reason graph.js refuses to
 * guess: with `knownAutomationIds` supplied, an id that is not in the set is
 * reported as MISSING — "the automation no longer exists", an error. One failed
 * lookup would produce that sentence about an automation nobody checked. So a pass
 * that cannot complete is abandoned, every unplaced automation stays UNRESOLVED
 * ("not in this project"), and the gap is named instead.
 *
 * Loading decisions worth stating:
 *   1. EVERY automation KIND, not just top-level ones. A `call_block` pointing
 *      at a reusable Step that IS in this project would otherwise be reported
 *      as an external dependency, purely because the listing query filters it.
 *   2. FULL app definitions, one query each: the wiring lives in the definition.
 *   3. AGENT CONFIGS ARE LOADED IN FULL, and never leave the server through
 *      this module's callers: only the EDGES reach a client.
 *
 * It authorises nothing: every caller resolves the project role, or the
 * project list, before it hands an id over.
 *
 * Dependencies come in through `deps` so tests inject doubles; whatever is not
 * injected is required lazily, inside the call, so a test that injects every
 * store never loads a real one.
 */

'use strict';

const defaultLog = require('../telemetry/log');

/** The stores and helpers this loader reads, with the real ones as fallback. */
function resolveDeps(deps = {}) {
    return {
        automationStore: deps.automationStore || require('../stores/automationStore'),
        studioAppStore: deps.studioAppStore || require('../stores/studioAppStore'),
        webpageStore: deps.webpageStore || require('../stores/webpageStore'),
        datatableStore: deps.datatableStore || require('../stores/datatableStore'),
        agentStore: deps.agentStore || require('../stores/agentStore'),
        kbMembership: deps.kbMembership || require('./knowledgeBaseMembership'),
        kbSources: deps.kbSources || require('../stores/kbSources'),
        buildProjectGraph: deps.buildProjectGraph || require('./graph').buildProjectGraph,
        log: deps.log || defaultLog,
    };
}

/** Accept a project row or its id: every caller has one or the other. */
function projectIdOf(project) {
    if (typeof project === 'string') return project;
    return typeof project?.id === 'string' ? project.id : null;
}

/**
 * @param {string|{id:string}} project  the project, or its id
 * @param {object} [deps]               store doubles; see resolveDeps
 * @returns {Promise<{graph:object, members:{apps:Array, automations:Array, knowledgeBases:Array}, unavailable:string[]}>}
 */
async function buildGraphForProject(project, deps = {}) {
    const projectId = projectIdOf(project);
    if (!projectId) throw new TypeError('buildGraphForProject needs a project id');
    const {
        automationStore, studioAppStore, webpageStore, datatableStore, agentStore,
        kbMembership, kbSources, buildProjectGraph, log,
    } = resolveDeps(deps);

    // Machine-readable section keys, so the client can name them in the
    // reader's own language instead of rendering a server-side English label.
    const unavailable = [];
    const miss = (section) => { if (!unavailable.includes(section)) unavailable.push(section); };

    // Each member kind loads INDEPENDENTLY and an unreachable store costs its
    // own lines, not the whole picture — the same rule the Content tab follows.
    // A graph drawn from four of six kinds is still true about those four;
    // refusing to draw anything would say nothing at all. What it must NOT do
    // is let those two kinds read as empty.
    const some = async (section, fn) => {
        try { return await fn(); } catch (err) {
            log.warn(`[Projects] graph: could not load ${section}:`, err.message);
            miss(section);
            return null;
        }
    };

    const [automations, appMetas, webpages, datatables, agentMetas, knowledgeBases] = await Promise.all([
        some('automations', () => automationStore.getAutomationsForProject(projectId, { kinds: ['automation', 'block', 'layer'] })),
        some('apps', () => studioAppStore.listProjectApps(projectId)),
        some('webpages', () => webpageStore.listProjectWebpages(projectId)),
        some('datatables', () => datatableStore.listDatatablesForProject(projectId)),
        some('agents', () => agentStore.listProjectAgents(projectId)),
        some('knowledgeBases', () => kbMembership.listProjectKnowledgeBases(projectId)),
    ]);

    const appReads = await Promise.all(
        (appMetas || []).map(m => studioAppStore.getStudioApp(m.id).catch(() => null)),
    );
    // An app whose definition would not load is NOT an app without wiring: it
    // is an app nobody could look at. Dropping it silently removed its broken
    // edges along with it.
    if (appReads.some(a => !a)) miss('apps');
    const apps = appReads.filter(Boolean);

    // The config is what carries the wiring, and it stays on this side of the
    // wire.
    const agentReads = await Promise.all(
        (agentMetas || []).map(m => agentStore.getAgent(m.id).catch(() => null)),
    );
    if (agentReads.some(a => !a)) miss('agents');
    const agents = agentReads.filter(Boolean).map(a => ({ id: a.id, name: a.name, ownerId: a.owner_id, config: a.config }));

    // "Every meeting tagged X" is a knowledge SOURCE, so it is read here and
    // passed in — projects/graph.js does no I/O of its own.
    const meetingSources = [];
    for (const kb of (knowledgeBases || [])) {
        let sources;
        try { sources = await kbSources.listByKb(kb.id); } catch (err) {
            log.warn('[Projects] graph: could not load knowledge sources:', err.message);
            miss('knowledgeSources');
            continue;
        }
        for (const src of (sources || [])) {
            if (src?.kind !== 'meeting_tag') continue;
            const tag = src.config?.tag;
            if (typeof tag === 'string' && tag.trim()) {
                meetingSources.push({ knowledgeBaseId: kb.id, tag: tag.trim() });
            }
        }
    }

    const input = {
        project: { id: projectId },
        automations: automations || [], apps, webpages: webpages || [],
        datatables: datatables || [], agents, knowledgeBases: knowledgeBases || [], meetingSources,
    };
    let graph = buildProjectGraph(input);

    const unplacedAutomations = graph.externals.filter(e => e.kind === 'automation');
    if (unplacedAutomations.length) {
        const known = new Set();
        let checkedAll = true;
        for (const ext of unplacedAutomations) {
            try {
                if (await automationStore.getAutomation(ext.id)) known.add(ext.id);
            } catch (err) {
                log.warn('[Projects] graph: could not check automation existence:', err.message);
                checkedAll = false;
                break;
            }
        }
        // Only a COMPLETE pass may promote UNRESOLVED to MISSING — see the
        // header. A partial one is thrown away rather than used to tell someone
        // their automation was deleted.
        if (checkedAll) graph = buildProjectGraph({ ...input, knownAutomationIds: known });
        else miss('automationExistence');
    }

    // The members travel back with the graph so GET /:id/completeness can run
    // the validators over the SAME rows this walk was drawn from — a second
    // read would let the two screens disagree about what is in the Solution.
    return {
        graph: { ...graph, unavailable, complete: unavailable.length === 0 },
        members: { apps, automations: automations || [], knowledgeBases: knowledgeBases || [] },
        unavailable,
    };
}

module.exports = { buildGraphForProject };
