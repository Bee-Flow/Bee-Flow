/**
 * The dependency graph of a Solution: which app runs which automation, which
 * automation asks whom to approve, which page is allowed to call what.
 *
 * ── Why this module is the spine ────────────────────────────────────────────
 *
 * The same walk that draws the picture decides what a Blueprint can carry.
 * An edge pointing INSIDE the project is a reference the packager rewrites; an
 * edge pointing OUTSIDE it is a `requires` entry the installer must satisfy by
 * hand. Two separate walks would eventually disagree about which is which, and
 * the symptom would be a Blueprint that installs cleanly and does nothing.
 *
 * ── Pure, on purpose ────────────────────────────────────────────────────────
 *
 * No database, no I/O, no requires beyond two shared walkers. The caller loads
 * the project's members and passes them in. That is what makes every
 * broken-edge class below testable as a plain object, which matters because
 * broken edges are the entire point of the feature.
 *
 * ── Every edge is already on disk ───────────────────────────────────────────
 *
 *   app     → automation   an action of kind 'run_automation'
 *   app     → approval     an action of kind 'request_approval'
 *   automation → approval  a step of type 'approval'
 *   automation → automation a step of type 'call_block' (a reusable Step)
 *   webpage → automation   an entry in bridge_grants.automations[]
 *   automation → datatable a step of type 'datatable' (read or write)
 *   agent   → knowledge_base  config.knowledge_base_ids
 *   agent   → skill        config.attachedSkillIds
 *   meeting → knowledge_base  a kb_source of kind 'meeting_tag'
 *   form    → automation   a definition whose TRIGGER is a form
 *
 * Approvals are not entities, so they appear as SYNTHETIC nodes derived from
 * the policy that would raise them. That is deliberate and matches how a
 * Blueprint treats them: what travels is the policy, never the decision.
 * Forms and meeting tags are synthetic for the same reason, and in the form's
 * case for a second one that matters more: an `automation_form_pages.id` IS
 * the public URL and IS the only credential guarding it (192 bits, no second
 * factor). It is never read here and must never appear in a graph or a
 * Blueprint. A form node is derived from the TRIGGER, which carries no token.
 *
 * ── The datatable edge comes from the definition, not the usage index ───────
 *
 * `automation_datatable_usage` is the persisted index, and reading it would
 * make this module do I/O. `automation/datatableUsage.collectDatatableUsage`
 * derives the same facts from the definition, purely — the same walk over
 * loops, branches and layers — so the graph keeps its "no database" promise
 * and cannot disagree with the index about what an automation touches.
 *
 * An app→datatable edge is NOT drawn yet, and the hook that would draw it says
 * why: the app definition does not carry the binding in a readable form, and
 * the usage index has no app rows because the reconciler that writes them has
 * not landed (`SAVE_PATHS.app` in automation/usageSync is still empty). Zero
 * edges is the honest answer, and appDatatableIds() is where the answer changes
 * when it stops being zero.
 *
 * ── The failure this exists to surface ──────────────────────────────────────
 *
 * A cross-owner edge passes every review and fails at the first click.
 * actionExecutor refuses to run an automation whose owner is not the app's
 * owner, and a webpage bridge runs acts-as-author, so a project built by two
 * people can be wired entirely correctly and still be broken for everyone.
 * Nothing tells you until a user presses the button. Now something does.
 */

const { walkObjects } = require('../appStudio/templateCapture');
const { walkAllSteps } = require('../automation/portability');
// The third shared walker. Pure, like the other two: a definition in, the
// tables its steps touch out — loop bodies, branches and inline layers
// included. See the header on why this rather than the persisted usage index.
const { collectDatatableUsage } = require('../automation/datatableUsage');

/** Problem codes, so a caller can style or filter without matching prose. */
const PROBLEM = {
    UNWIRED: 'unwired',              // the reference was never filled in
    MISSING: 'missing',              // the target does not exist at all
    EXTERNAL: 'external',            // it exists, but outside this Solution
    UNRESOLVED: 'unresolved',        // outside this Solution; existence unknown
    CROSS_OWNER: 'cross_owner',      // it exists here, but will refuse to run
};

function nodeId(type, id) { return `${type}:${id}`; }

function approvalNodeId(ownerType, ownerId, stepId) {
    return `approval:${ownerType}:${ownerId}:${stepId}`;
}

/**
 * The synthetic node for an automation's own form.
 *
 * Keyed on the AUTOMATION, never on the form page: the page's id is its URL and
 * its credential. An automation has one form trigger, so the automation id is a
 * complete key anyway.
 */
function formNodeId(automationId) { return `form:${automationId}`; }

/** The synthetic node for "every meeting tagged X". The tag is author text. */
function meetingNodeId(tag) { return `meeting:${tag}`; }

/**
 * Classify one automation reference.
 *
 * `known` is the set of automation ids that exist beyond this project. When the
 * caller cannot supply it the verdict is UNRESOLVED rather than MISSING —
 * "I could not check" must not be reported as "it is gone".
 */
function classify(targetId, byId, known) {
    if (!targetId) return PROBLEM.UNWIRED;
    if (byId.has(targetId)) return null;
    if (!known) return PROBLEM.UNRESOLVED;
    return known.has(targetId) ? PROBLEM.EXTERNAL : PROBLEM.MISSING;
}

/**
 * What each kind of target is CALLED in a sentence.
 *
 * The prose used to say "an automation" because an automation was the only thing an
 * edge could point at. Now that a reference can be a table, a knowledge base or
 * a skill, the noun is a parameter — an unknown kind falls back to the neutral
 * "thing" rather than claiming the wrong one.
 */
const TARGET_NOUN = {
    automation: 'automation',
    datatable: 'table',
    knowledge_base: 'knowledge base',
    skill: 'skill',
};

/** "a table", "an automation": the article the noun takes. */
const withArticle = (noun) => `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;

const PROSE = {
    [PROBLEM.UNWIRED]: (from, target, noun = 'automation') => `${from} has a step that never got ${withArticle(noun)} picked, so it does nothing when someone uses it.`,
    [PROBLEM.MISSING]: (from, target, noun = 'automation') => `${from} points at ${withArticle(noun)} that no longer exists (${target}).`,
    [PROBLEM.EXTERNAL]: (from, target, noun = 'automation') => `${from} depends on ${withArticle(noun)} outside this project (${target}), so packaging cannot carry it.`,
    [PROBLEM.UNRESOLVED]: (from, target, noun = 'automation') => `${from} points at ${withArticle(noun)} that is not in this project (${target}).`,
    // Deliberately NOT parameterised: cross-owner is the acts-as-owner refusal,
    // and only an automation is ever executed that way.
    [PROBLEM.CROSS_OWNER]: (from, target) => `${from} runs an automation owned by someone else (${target}). It will refuse at the moment someone presses the button — both must belong to the same person.`,
};

/**
 * The severity each problem carries on the shared Finding shape
 * (core/findings/finding.js). What is broken the moment someone clicks is an
 * error; what is a normal state while building (the "connect an automation" state
 * every template ships in), or a limit on packaging rather than on running,
 * is a warning. UNRESOLVED is "I could not check" and must never read as "it
 * is gone" — see classify().
 */
const SEVERITY = {
    [PROBLEM.UNWIRED]: 'warning',
    [PROBLEM.MISSING]: 'error',
    [PROBLEM.EXTERNAL]: 'warning',
    [PROBLEM.UNRESOLVED]: 'warning',
    [PROBLEM.CROSS_OWNER]: 'error',
};

/**
 * Which datatables an APP is bound to.
 *
 * Zero, today, and that is a fact rather than a stub: an App Studio definition
 * carries no `datatableId` in any readable form (`grep datatableId
 * server/appStudio/` finds nothing), and the persisted usage index has no app
 * rows either — the reconciler that would write them has not landed, which is
 * why `SAVE_PATHS.app.sync.files` in automation/usageSync.savePaths.test.js is
 * still an empty list with a note saying who fills it in.
 *
 * Returning [] keeps the edge honest: the Flow tab draws no line rather than a
 * line nobody can verify. When the binding lands, this function is the ONE
 * place that changes and the rest of the walk below already handles it.
 */
function appDatatableIds(_app) { return []; }

/**
 * @param {object} input
 * @param {object} input.project
 * @param {Array}  input.automations  every kind — blocks and layers included
 * @param {Array}  input.apps         WITH their definitions, not meta only
 * @param {Array}  input.webpages
 * @param {Array}  [input.datatables] the tables filed into this project
 * @param {Array}  [input.agents]     WITH their parsed `config`
 * @param {Array}  [input.knowledgeBases] the bases this project links
 * @param {Array}  [input.meetingSources] `{ knowledgeBaseId, tag }` per
 *                 `meeting_tag` knowledge source — READ by the caller, so this
 *                 module keeps doing no I/O of its own
 * @param {Set}    [input.knownAutomationIds]  ids that exist outside the project
 * @param {Set}    [input.knownDatatableIds]
 * @param {Set}    [input.knownKnowledgeBaseIds]
 * @returns {{nodes: Array, edges: Array, externals: Array, problems: Array}}
 */
function buildProjectGraph({
    project = null, automations = [], apps = [], webpages = [],
    datatables = [], agents = [], knowledgeBases = [], meetingSources = [],
    knownAutomationIds = null, knownDatatableIds = null, knownKnowledgeBaseIds = null,
} = {}) {
    const nodes = [];
    const edges = [];
    const problems = [];
    const externals = [];

    const automationById = new Map(automations.filter(Boolean).map(a => [a.id, a]));
    const datatableById = new Map(datatables.filter(Boolean).map(d => [d.id, d]));
    const knowledgeBaseById = new Map(knowledgeBases.filter(Boolean).map(k => [k.id, k]));
    // A skill is never a member of a project, so there is no in-bundle map to
    // check against — every reference to one leaves the Solution by definition
    // and is reported as a dependency the installer supplies.
    const skillById = new Map();

    /** The lookup table and the "does it exist elsewhere" set, per target kind. */
    const WORLD = {
        automation: { byId: automationById, known: knownAutomationIds },
        datatable: { byId: datatableById, known: knownDatatableIds },
        knowledge_base: { byId: knowledgeBaseById, known: knownKnowledgeBaseIds },
        skill: { byId: skillById, known: null },
    };

    for (const a of automations.filter(Boolean)) {
        nodes.push({ id: nodeId('automation', a.id), type: 'automation', entityId: a.id, name: a.title || 'Untitled automation', ownerId: a.userId || null, kind: a.kind || 'automation' });
    }
    for (const app of apps.filter(Boolean)) {
        nodes.push({ id: nodeId('app', app.id), type: 'app', entityId: app.id, name: app.name || 'Untitled app', ownerId: app.userId || null });
    }
    for (const w of webpages.filter(Boolean)) {
        nodes.push({ id: nodeId('webpage', w.id), type: 'webpage', entityId: w.id, name: w.name || 'Untitled page', ownerId: w.userId || null });
    }
    for (const d of datatables.filter(Boolean)) {
        nodes.push({ id: nodeId('datatable', d.id), type: 'datatable', entityId: d.id, name: d.name || 'Untitled table', ownerId: d.ownerUserId || null });
    }
    for (const ag of agents.filter(Boolean)) {
        nodes.push({ id: nodeId('agent', ag.id), type: 'agent', entityId: ag.id, name: ag.name || 'Untitled agent', ownerId: ag.ownerId || ag.owner_id || null });
    }
    for (const kb of knowledgeBases.filter(Boolean)) {
        // A base has no owner in this picture: what matters here is that it is
        // IN the project, and who may read it is the Knowledge screens' answer.
        nodes.push({ id: nodeId('knowledge_base', kb.id), type: 'knowledge_base', entityId: kb.id, name: kb.name || 'Untitled knowledge base', ownerId: null });
    }

    /**
     * One problem, in the shared Finding shape plus the graph's own fields.
     * The prose is rendered HERE, at construction — a `message` travels
     * through JSON and can be translated, a formatter map cannot. `fromRef`
     * is the object that HOLDS the broken reference: that is where "Show me"
     * opens, so it is the Finding's `kind` + `targetRef`; the automation it
     * points at stays in `targetId`.
     */
    const addProblem = (code, fromNode, fromName, targetId, fromRef, targetKind = 'automation') => {
        const targetRef = { kind: fromRef.kind, id: fromRef.id ?? null };
        if (fromRef.title) targetRef.title = fromRef.title;
        if (fromRef.stepId) targetRef.stepId = fromRef.stepId;
        problems.push({
            code,
            severity: SEVERITY[code],
            from: fromNode,
            targetId: targetId || null,
            message: PROSE[code](fromName, targetId, TARGET_NOUN[targetKind] || 'thing'),
            kind: fromRef.kind,
            targetRef,
        });
    };

    // Deduped on kind AND id: two kinds can only collide by accident, and an
    // accident that merged a missing table into a missing automation would report
    // one dependency where there are two.
    const noteExternal = (targetKind, targetId, byNode) => {
        const seen = externals.find(e => e.id === targetId && e.kind === targetKind);
        if (seen) { if (!seen.referencedBy.includes(byNode)) seen.referencedBy.push(byNode); return; }
        externals.push({ kind: targetKind, id: targetId, referencedBy: [byNode] });
    };

    /**
     * One reference to something else, from anywhere, with the ownership rule
     * applied. `fromRef` = `{ kind, id, title?, stepId? }` of the referencing
     * object, for the Finding half of any problem this raises.
     *
     * `targetKind` selects which world the reference is classified against —
     * see WORLD above. It defaults to 'automation' because that is what every
     * caller meant when this function only knew about one kind.
     */
    const linkTo = ({ fromNode, fromName, fromOwnerId, fromRef, targetId, edgeKind, actsAsOwner, targetKind = 'automation' }) => {
        const world = WORLD[targetKind] || { byId: new Map(), known: null };
        const verdict = classify(targetId, world.byId, world.known);
        const edge = { from: fromNode, to: targetId ? nodeId(targetKind, targetId) : null, kind: edgeKind, targetId: targetId || null, problem: verdict };

        if (verdict === PROBLEM.EXTERNAL || verdict === PROBLEM.UNRESOLVED || verdict === PROBLEM.MISSING) {
            if (verdict !== PROBLEM.MISSING) noteExternal(targetKind, targetId, fromNode);
            addProblem(verdict, fromNode, fromName, targetId, fromRef, targetKind);
        } else if (verdict === PROBLEM.UNWIRED) {
            addProblem(verdict, fromNode, fromName, null, fromRef, targetKind);
        } else if (actsAsOwner) {
            // The target is in this project — but these two call paths execute
            // as the CALLER's owner, and refuse outright when the automation
            // belongs to somebody else.
            const target = world.byId.get(targetId);
            if (fromOwnerId && target?.userId && target.userId !== fromOwnerId) {
                edge.problem = PROBLEM.CROSS_OWNER;
                addProblem(PROBLEM.CROSS_OWNER, fromNode, fromName, targetId, fromRef);
            }
        }
        edges.push(edge);
    };

    // ── Apps: run_automation and request_approval ───────────────────────
    for (const app of apps.filter(Boolean)) {
        const from = nodeId('app', app.id);
        const name = app.name || 'An app';
        let approvalSeq = 0;
        walkObjects(app.definition, (obj) => {
            if (obj.kind === 'run_automation') {
                linkTo({
                    fromNode: from, fromName: name, fromOwnerId: app.userId,
                    fromRef: { kind: 'app', id: app.id, title: app.name || null },
                    targetId: typeof obj.automationId === 'string' ? obj.automationId : null,
                    edgeKind: 'runs', actsAsOwner: true,
                });
            }
            if (obj.kind === 'request_approval') {
                const id = approvalNodeId('app', app.id, obj.id || `a${++approvalSeq}`);
                nodes.push({ id, type: 'approval', entityId: null, name: 'Approval', raisedBy: from });
                edges.push({ from, to: id, kind: 'asks', targetId: null, problem: null });
            }
        });
    }

    // ── Automations: approval steps and call_block ──────────────────────
    for (const a of automations.filter(Boolean)) {
        const from = nodeId('automation', a.id);
        const name = a.title || 'An automation';
        walkAllSteps(a.definition, (step, layerKey) => {
            if (step.type === 'approval') {
                const id = approvalNodeId('automation', a.id, step.id || 'step');
                nodes.push({ id, type: 'approval', entityId: null, name: step.prompt || 'Approval', raisedBy: from, layerKey: layerKey || null });
                edges.push({ from, to: id, kind: 'asks', targetId: null, problem: null });
            }
            if (step.type === 'call_block') {
                linkTo({
                    fromNode: from, fromName: name, fromOwnerId: a.userId,
                    fromRef: { kind: 'automation', id: a.id, title: a.title || null, stepId: typeof step.id === 'string' ? step.id : null },
                    targetId: typeof step.blockId === 'string' ? step.blockId : null,
                    // A block runs inside the caller's own run, under the
                    // caller's identity, so ownership is not a second gate.
                    edgeKind: 'calls', actsAsOwner: false,
                });
            }
        });
    }

    // ── Webpages: the bridge allowlist ──────────────────────────────────
    for (const w of webpages.filter(Boolean)) {
        const from = nodeId('webpage', w.id);
        const name = w.name || 'A page';
        const grants = w.bridgeGrants?.automations;
        if (!Array.isArray(grants)) continue;
        for (const grant of grants) {
            if (!grant) continue;
            linkTo({
                fromNode: from, fromName: name, fromOwnerId: w.userId,
                fromRef: { kind: 'webpage', id: w.id, title: w.name || null },
                targetId: typeof grant.automationId === 'string' ? grant.automationId : null,
                // The bridge runs acts-as-author, same refusal as an app action.
                edgeKind: 'runs', actsAsOwner: true,
            });
        }
    }

    // ── Automations: the tables their steps read and write ──────────────
    for (const a of automations.filter(Boolean)) {
        const from = nodeId('automation', a.id);
        const name = a.title || 'An automation';
        for (const use of collectDatatableUsage(a.definition)) {
            linkTo({
                fromNode: from, fromName: name, fromOwnerId: a.userId,
                fromRef: { kind: 'automation', id: a.id, title: a.title || null, stepId: use.stepId || null },
                targetId: use.datatableId, targetKind: 'datatable',
                // A datatable step runs inside the automation's own run, under the
                // runner's identity, and the grade is re-checked there — so
                // ownership is not a second gate the way it is for an app
                // action. Reading and writing are separate verbs because they
                // are separate risks.
                edgeKind: use.mode === 'write' ? 'writes' : 'reads', actsAsOwner: false,
            });
        }
    }

    // ── Apps: the tables they are bound to (none yet — see appDatatableIds) ─
    for (const app of apps.filter(Boolean)) {
        const from = nodeId('app', app.id);
        const name = app.name || 'An app';
        for (const tableId of appDatatableIds(app)) {
            linkTo({
                fromNode: from, fromName: name, fromOwnerId: app.userId,
                fromRef: { kind: 'app', id: app.id, title: app.name || null },
                targetId: tableId, targetKind: 'datatable',
                edgeKind: 'uses', actsAsOwner: false,
            });
        }
    }

    // ── Agents: what they are grounded on, and what they can do ─────────
    //
    // The two config keys are spelled differently and that is not a typo here:
    // `knowledge_base_ids` is snake_case and `attachedSkillIds` is camelCase in
    // the stored config, so both spellings are read exactly as written.
    for (const ag of agents.filter(Boolean)) {
        const from = nodeId('agent', ag.id);
        const name = ag.name || 'An agent';
        const config = (ag.config && typeof ag.config === 'object') ? ag.config : {};
        const fromRef = { kind: 'agent', id: ag.id, title: ag.name || null };

        for (const kbId of (Array.isArray(config.knowledge_base_ids) ? config.knowledge_base_ids : [])) {
            if (typeof kbId !== 'string' || !kbId) continue;
            linkTo({
                fromNode: from, fromName: name, fromOwnerId: ag.ownerId || ag.owner_id || null, fromRef,
                targetId: kbId, targetKind: 'knowledge_base', edgeKind: 'grounds', actsAsOwner: false,
            });
        }
        for (const skillId of (Array.isArray(config.attachedSkillIds) ? config.attachedSkillIds : [])) {
            if (typeof skillId !== 'string' || !skillId) continue;
            // A skill is never a member of a project, so this ALWAYS points
            // outside the Solution. That is the honest answer rather than an
            // omission: whoever installs the Blueprint has to supply the skill,
            // and `requires` is where they are told so.
            linkTo({
                fromNode: from, fromName: name, fromOwnerId: ag.ownerId || ag.owner_id || null, fromRef,
                targetId: skillId, targetKind: 'skill', edgeKind: 'uses', actsAsOwner: false,
            });
        }
    }

    // ── Meetings: "every meeting tagged X" feeding a knowledge base ──────
    //
    // The sources are READ by the caller and passed in, so this module still
    // touches no database. The tag is author-chosen text ("sales"), never a
    // person and never an identifier of one.
    for (const src of meetingSources.filter(Boolean)) {
        const tag = typeof src.tag === 'string' ? src.tag.trim() : '';
        const kbId = typeof src.knowledgeBaseId === 'string' ? src.knowledgeBaseId : '';
        if (!tag || !kbId) continue;
        const id = meetingNodeId(tag);
        if (!nodes.some(n => n.id === id)) {
            nodes.push({ id, type: 'meeting', entityId: null, name: tag });
        }
        linkTo({
            fromNode: id, fromName: `Meetings tagged "${tag}"`, fromOwnerId: null,
            // The reference lives in the knowledge base's own sources, so that
            // is where "show me" opens.
            fromRef: { kind: 'knowledge_base', id: kbId },
            targetId: kbId, targetKind: 'knowledge_base', edgeKind: 'feeds', actsAsOwner: false,
        });
    }

    // ── Forms: an automation whose TRIGGER is a public form ──────────────────
    //
    // Derived from the trigger, never from `automation_form_pages`: that row's
    // id is the public URL AND the only credential guarding it, so it is not
    // read here and can never reach a graph payload or a Blueprint.
    for (const a of automations.filter(Boolean)) {
        if (a.definition?.trigger?.kind !== 'form') continue;
        const to = nodeId('automation', a.id);
        const id = formNodeId(a.id);
        const authored = a.definition.trigger.form?.title;
        const title = (typeof authored === 'string' && authored.trim()) ? authored.trim() : 'Form';
        nodes.push({ id, type: 'form', entityId: null, name: title, triggers: to });
        edges.push({ from: id, to, kind: 'triggers', targetId: a.id, problem: null });
    }

    return { projectId: project?.id || null, nodes, edges, externals, problems };
}

module.exports = { buildProjectGraph, PROBLEM, PROSE, SEVERITY };
