/**
 * The parts a Solution part needs in order to work, and whether they can come
 * along when it is added.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * An app that runs an automation, an automation that writes a table, an agent grounded
 * on a knowledge base: file only the first of each into a Solution and the
 * release check flags every one of them as a dependency that "is not in this
 * Solution". The Studio add-parts panel asks this module what else is needed
 * BEFORE it files anything, so the person adding a part is told what comes
 * along and why, instead of finding out at release time.
 *
 * ── Edges come from the pointer registry ────────────────────────────────────
 *
 * Nothing here parses a definition. `packaging/pointers.js` already lists every
 * place one part points at another (capture, install and the release checks
 * read it), so this walk asks the same registry. It is a superset of what
 * `graph.js` draws (the graph has no document template, no `ai_step`
 * knowledge/skill/agent, no table grant of an app or page); relatedParts.test.js
 * proves that every edge the graph draws is found here too, so the two cannot
 * disagree about a wiring the Flow tab shows. Only the datatable READ/WRITE
 * verb needs a second source, `datatableUsage.collectDatatableUsage`, the very
 * function graph.js uses for it.
 *
 * ── Outgoing edges only ─────────────────────────────────────────────────────
 *
 * What a part USES comes along (it cannot work without it). What uses the part
 * does not: adding an automation does not drag in the apps that happen to call it.
 *
 * ── The same ownership rule as PUT /:id/resources ───────────────────────────
 *
 * Owner and current project are read through the membership registry's own
 * `ownerOf` / `projectOf` (the stage gate's readers), and a knowledge base
 * through the same read-access check `setKnowledgeBaseProject` makes, so
 * "addable" here means the PUT will take it. Three consequences:
 *
 *   - a part that is not the caller's is reported `not_yours` WITHOUT its name,
 *     and its definition is never read, so the walk cannot be used to browse
 *     what a colleague built;
 *   - a part filed in another project is reported `in_other_solution` and is
 *     NOT addable: PUT would silently move it out of the Solution it belongs
 *     to, which is a decision for its owner, not a side effect of an add. The
 *     other Solution's name is given only when the caller has a role there;
 *   - only an addable part is expanded further, so the walk never reads the
 *     definition of anything the caller may not file.
 *
 * ── Shape and limits ────────────────────────────────────────────────────────
 *
 * `related` lists dependencies first (a part comes before whatever needs it),
 * so a client can attach in order. The walk visits at most MAX_RELATED parts
 * and says so in `truncated` rather than pretending the list is whole.
 *
 * The data sources are on one `seams` object, so a test swaps a function on it
 * (testUtils/swaps.js) or hands `findRelatedParts` a replacement, without
 * touching the module system.
 */

'use strict';

const { visitPointers } = require('./packaging/pointers');
const { collectDatatableUsage } = require('../automation/datatableUsage');
const membership = require('./membership');

/** The most related parts one request walks to; more than this is reported, not followed. */
const MAX_RELATED = 200;

/** Short codes the client turns into a sentence. Stable: the UI keys i18n on them. */
const RELATION = Object.freeze({
    RUNS: 'runs',
    CALLS: 'calls',
    READS_TABLE: 'reads_table',
    WRITES_TABLE: 'writes_table',
    USES_TABLE: 'uses_table',
    USES_TEMPLATE: 'uses_template',
    USES_SKILL: 'uses_skill',
    USES_AGENT: 'uses_agent',
    GROUNDS_ON_KB: 'grounds_on_kb',
    WRITES_KB: 'writes_kb',
    SKILL_RUNS: 'skill_runs',
});

const STATUS = Object.freeze({
    ADDABLE: 'addable',
    ALREADY_HERE: 'already_here',
    IN_OTHER_SOLUTION: 'in_other_solution',
    NOT_YOURS: 'not_yours',
    NOT_FOUND: 'not_found',
});

/** The pointer registry's names for a target, in the membership registry's. */
const MEMBER_KIND = Object.freeze({
    automation: 'automation',
    datatable: 'datatable',
    knowledgeBase: 'knowledge_base',
    skill: 'skill',
    agent: 'agent',
    document: 'document_template',
});

const isId = (v) => typeof v === 'string' && v.trim() !== '';
const keyOf = (kind, id) => `${kind}:${id}`;

// ── Edges ───────────────────────────────────────────────────────────────────

/** How a pointer reads to a person: the relation code for (holder, pointer). */
function relationOf(holder, ptr, tableMode) {
    switch (ptr.targetKind) {
        case 'automation':
            if (holder === 'automation') return RELATION.CALLS;
            return holder === 'skill' ? RELATION.SKILL_RUNS : RELATION.RUNS;
        case 'datatable':
            if (ptr.field === 'cacheInto.datatableId') return RELATION.WRITES_TABLE;
            if (holder === 'automation') return tableMode(ptr.stepId) === 'write' ? RELATION.WRITES_TABLE : RELATION.READS_TABLE;
            return RELATION.USES_TABLE;
        case 'knowledgeBase':
            return holder === 'automation' && ptr.field === 'knowledgeBaseId' ? RELATION.WRITES_KB : RELATION.GROUNDS_ON_KB;
        case 'skill': return RELATION.USES_SKILL;
        case 'agent': return RELATION.USES_AGENT;
        case 'document': return RELATION.USES_TEMPLATE;
        default: return null;
    }
}

/**
 * Every part `payload` (a holder of `kind`) points at.
 *
 * @param {string} kind     a membership kind
 * @param {object} payload  the holder shape pointers.js documents for it
 * @returns {Array<{kind: string, id: string, relation: string}>} deduped on kind + id
 */
function edgesOf(kind, payload) {
    const usage = kind === 'automation' ? collectDatatableUsage(payload?.definition) : [];
    const modeByStep = new Map(usage.map(u => [u.stepId, u.mode]));
    const tableMode = (stepId) => modeByStep.get(stepId) || 'read';
    const out = [];
    const seen = new Set();
    visitPointers(kind, payload, (ptr) => {
        const targetKind = MEMBER_KIND[ptr.targetKind];
        if (!targetKind) return;
        const raw = ptr.get();
        for (const id of (ptr.many ? (Array.isArray(raw) ? raw : []) : [raw])) {
            if (!isId(id)) continue;       // empty, or a `$ref` (a Blueprint, not a live id)
            const key = keyOf(targetKind, id);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ kind: targetKind, id, relation: relationOf(kind, ptr, tableMode) });
        }
    });
    return out;
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** A row the id of which the column type refuses is no row. */
async function readRow(sql, id) {
    try { return await require('../db').getOne(sql, [String(id)]); } catch (err) {
        if (err?.code === '22P02') return null;
        throw err;
    }
}

const jsonList = (v) => (Array.isArray(v) ? v : []);

/** name + holder payload per kind. A leaf kind has no payload. */
const READERS = {
    automation: async (id) => {
        const a = await require('../stores/automationStore').getAutomation(id);
        return a ? { name: a.title || null, payload: { definition: a.definition } } : null;
    },
    app: async (id, userId) => {
        const app = await require('../stores/studioAppStore').getStudioApp(id);
        if (!app) return null;
        // The data model sits in its own store and is owner-scoped; best effort,
        // like the builder: without it only the table bindings are missed.
        let dataModel = null;
        try { dataModel = (await require('../stores/studioAppDataStore').getDataModel(id, userId))?.model ?? null; } catch (_) { /* optional */ }
        return { name: app.name || null, payload: { definition: app.definition, dataModel } };
    },
    webpage: async (id) => {
        const w = await require('../stores/webpageStore').getWebpageRaw(id);
        return w ? { name: w.name || null, payload: { bridgeGrants: w.bridgeGrants, knowledgeBaseIds: w.knowledgeBaseIds } } : null;
    },
    agent: async (id) => {
        const a = await require('../stores/agentStore').getAgent(id);
        return a ? { name: a.name || null, payload: { config: a.config } } : null;
    },
    skill: async (id) => {
        const r = await readRow('SELECT name, knowledge_base_ids, allowed_automation_ids, automation_id FROM skills WHERE id = $1', id);
        return r ? {
            name: r.name || null,
            payload: {
                knowledge_base_ids: jsonList(r.knowledge_base_ids),
                allowed_automation_ids: jsonList(r.allowed_automation_ids),
                automation_id: r.automation_id || undefined,
            },
        } : null;
    },
    datatable: async (id) => {
        const r = await readRow('SELECT name FROM datatables WHERE id = $1', id);
        return r ? { name: r.name || null, payload: null } : null;
    },
    document_template: async (id) => {
        const r = await readRow('SELECT name FROM studio_documents WHERE id = $1', id);
        return r ? { name: r.name || null, payload: null } : null;
    },
    knowledge_base: async (id) => {
        const kb = await require('../stores/knowledgeBases').getKB(id);
        return kb ? { name: kb.name || null, payload: null } : null;
    },
};

/** The default data sources. Swap a member in a test; see the header. */
const seams = {
    /** @returns {Promise<string|null>} who owns the part, null when there is no such part */
    ownerOf: (kind, id) => membership.getKind(kind).ownerOf(id),
    /** @returns {Promise<string|null>} the project the part is filed in */
    projectOf: (kind, id) => membership.getKind(kind).projectOf(id),
    /** @returns {Promise<{name: string|null, payload: object|null}|null>} */
    readPart: (kind, id, userId) => READERS[kind](id, userId),
    /** May this caller attach the base? The very check setKnowledgeBaseProject makes. */
    async canAttachKnowledgeBase(req, kbId, project) {
        if (!req) return false;
        const { validateKnowledgeBaseIds } = require('./knowledgeBaseMembership');
        return (await validateKnowledgeBaseIds(req, [kbId], project?.organizationId)).ok;
    },
    /** The project's name when the caller has a role on it, else null. */
    async visibleProjectName(userId, projectId) {
        const role = await require('../auth/projectAccess').getProjectRole(userId, projectId);
        if (!role) return null;
        return (await require('../stores/projectStore').getProject(projectId))?.name || null;
    },
};

// ── The walk ────────────────────────────────────────────────────────────────

/**
 * Where a part stands for this caller and this Solution: its status, name and
 * (only when it may be expanded) the payload its edges are read from.
 */
async function standing(kind, id, { project, userId, req }, d) {
    const entry = membership.getKind(kind);
    let status;
    let projectIn = null;

    if (entry.linkOnProject) {
        // A base is linked from the project row, not filed by a column.
        const read = await d.readPart(kind, id, userId);
        if (!read) return { status: STATUS.NOT_FOUND, name: null, payload: null };
        const linked = Array.isArray(project.knowledgeBaseIds) && project.knowledgeBaseIds.includes(id);
        if (linked) return { status: STATUS.ALREADY_HERE, name: read.name, payload: null };
        const may = await d.canAttachKnowledgeBase(req, id, project);
        return may
            ? { status: STATUS.ADDABLE, name: read.name, payload: null }
            : { status: STATUS.NOT_YOURS, name: null, payload: null };
    }

    const [owner, filedIn] = await Promise.all([d.ownerOf(kind, id), d.projectOf(kind, id)]);
    projectIn = filedIn || null;
    if (!owner && !projectIn) return { status: STATUS.NOT_FOUND, name: null, payload: null };
    if (projectIn === project.id) {
        status = STATUS.ALREADY_HERE;
    } else if (owner !== userId) {
        // The same refusal the stores make: not yours, whoever holds it.
        return { status: STATUS.NOT_YOURS, name: null, payload: null };
    } else {
        status = projectIn ? STATUS.IN_OTHER_SOLUTION : STATUS.ADDABLE;
    }

    const read = await d.readPart(kind, id, userId);
    if (!read) return { status: STATUS.NOT_FOUND, name: null, payload: null };
    const out = { status, name: read.name, payload: status === STATUS.ADDABLE ? read.payload : null };
    if (status === STATUS.IN_OTHER_SOLUTION) out.solutionName = await d.visibleProjectName(userId, projectIn);
    return out;
}

/**
 * @param {object} input
 * @param {{id: string, kind?: string|null, knowledgeBaseIds?: string[], organizationId?: string}} input.project
 * @param {string} input.userId
 * @param {object} [input.req]      the request, for the knowledge-base read check
 * @param {Array<{kind: string, id: string}>} input.items   what is being added
 * @param {object} [d]              data sources; `seams` by default
 * @returns {Promise<{related: Array, truncated: boolean, items: Array}>}
 *          `items` repeats the roots with their standing, so the client can tell
 *          a part that will not file from one that will.
 */
async function findRelatedParts({ project, userId, req = null, items }, d = seams) {
    const ctx = { project, userId, req };
    const nodes = new Map();
    let truncated = false;
    let relatedCount = 0;

    const roots = [];
    for (const { kind, id } of items) {
        const key = keyOf(kind, id);
        if (nodes.has(key)) continue;
        const node = { key, kind, id, root: true, parents: new Map(), children: [] };
        nodes.set(key, node);
        roots.push(node);
    }

    const settle = async (batch) => {
        await Promise.all(batch.map(async (node) => Object.assign(node, await standing(node.kind, node.id, ctx, d))));
    };
    await settle(roots);

    let frontier = roots;
    while (frontier.length) {
        const fresh = [];
        for (const node of frontier) {
            if (node.status !== STATUS.ADDABLE || !node.payload || !membership.getKind(node.kind)) continue;
            for (const edge of edgesOf(node.kind, node.payload)) {
                // A kind this container does not hold (no automation in a workspace) is not a dependency here.
                if (!membership.isAllowedIn(edge.kind, project.kind)) continue;
                const key = keyOf(edge.kind, edge.id);
                if (key === node.key) continue;
                let target = nodes.get(key);
                if (!target) {
                    if (relatedCount >= MAX_RELATED) { truncated = true; continue; }
                    relatedCount += 1;
                    target = { key, kind: edge.kind, id: edge.id, root: false, parents: new Map(), children: [] };
                    nodes.set(key, target);
                    fresh.push(target);
                }
                if (!target.parents.has(node.key)) target.parents.set(node.key, { node, relation: edge.relation });
                node.children.push(key);
            }
        }
        await settle(fresh);
        frontier = fresh;
    }

    // Dependencies first: post-order over the discovered edges. A cycle (two
    // automations calling each other) is cut by the visited set.
    const ordered = [];
    const visited = new Set();
    const visit = (node) => {
        if (visited.has(node.key)) return;
        visited.add(node.key);
        for (const childKey of node.children) visit(nodes.get(childKey));
        if (!node.root) ordered.push(node);
    };
    roots.forEach(visit);

    const related = ordered.map((node) => {
        const via = [...node.parents.values()].map(({ node: parent, relation }) => ({
            kind: parent.kind, id: parent.id, name: parent.name || null, relation,
        }));
        const part = {
            kind: node.kind, id: node.id, name: node.name || null,
            relation: via[0]?.relation || null, via, status: node.status,
        };
        if (node.status === STATUS.IN_OTHER_SOLUTION) part.solutionName = node.solutionName || null;
        return part;
    });

    return {
        related,
        truncated,
        items: roots.map(r => ({ kind: r.kind, id: r.id, name: r.name || null, status: r.status })),
    };
}

module.exports = { findRelatedParts, edgesOf, seams, MAX_RELATED, RELATION, STATUS };
