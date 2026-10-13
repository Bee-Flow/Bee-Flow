/**
 * What every phase of a stage deployment shares: the injectable stores
 * (`storesOf`), the deployment journal (`makeJournal`) and the actions that
 * write a part (`WRITE_ACTIONS`).
 *
 * These lived in prepare.js, so commit.js, compensate.js, converge.js,
 * removeStage.js and runner.js all required prepare for them, while prepare
 * requires commit for the PRD preflight: a cycle. A leaf they all require keeps
 * the graph one-way. prepare.js re-exports every name here unchanged.
 */

'use strict';

const dep = (deps, name, load) => (deps && deps[name] !== undefined ? deps[name] : load());

/** Actions that write a part. `unchanged` writes nothing. */
const WRITE_ACTIONS = Object.freeze(['create', 'replace', 'revive']);

/** The stores and engine modules prepare (and the later phases) use; each one injectable. */
function storesOf(deps = {}) {
    return {
        get stageStore() { return dep(deps, 'solutionStageStore', () => require('../../stores/solutionStageStore')); },
        get blueprintStore() { return dep(deps, 'blueprintStore', () => require('../../stores/blueprintStore')); },
        get automationStore() { return dep(deps, 'automationStore', () => require('../../stores/automationStore')); },
        get studioAppStore() { return dep(deps, 'studioAppStore', () => require('../../stores/studioAppStore')); },
        get studioAppDataStore() { return dep(deps, 'studioAppDataStore', () => require('../../stores/studioAppDataStore')); },
        get webpageStore() { return dep(deps, 'webpageStore', () => require('../../stores/webpageStore')); },
        get agentStore() { return dep(deps, 'agentStore', () => require('../../stores/agentStore')); },
        get kbStore() { return dep(deps, 'kbStore', () => require('../../stores/knowledgeBases')); },
        get datatableStore() { return dep(deps, 'datatableStore', () => require('../../stores/datatableStore')); },
        get datatableDbStore() { return dep(deps, 'datatableDbStore', () => require('../../stores/datatableDbStore')); },
        get projectStore() { return dep(deps, 'projectStore', () => require('../../stores/projectStore')); },
        get skillStore() { return dep(deps, 'skillStore', () => require('../../stores/skillStore')); },
        get templates() { return dep(deps, 'solutionTemplates', () => require('../../stores/document/solutionTemplates')); },
        get install() { return dep(deps, 'install', () => require('../packaging/install')); },
        get withTransaction() { return dep(deps, 'withTransaction', () => require('../../db').withTransaction); },
    };
}

// ── The journal ──────────────────────────────────────────────────────────────

/**
 * A journal over one deployment and phase: `pending(action, row)` writes the
 * row before the write it describes and answers a `done(patch)` /
 * `failed()` pair; `record(action, row)` writes a finished row at once.
 * `row` is `{ ref, kind, entityId, before, afterHash, detail }`; `detail`
 * holds ids, versions and counts only.
 */
function makeJournal(stageStore, deploymentId, phase, { client = null } = {}) {
    const opts = client ? { client } : {};
    return {
        async pending(action, row = {}) {
            const step = await stageStore.appendStep(deploymentId, { phase, action, status: 'pending', ...row }, opts);
            return {
                seq: step.seq,
                done: (patch = {}) => stageStore.updateStep(deploymentId, step.seq, { status: 'done', ...patch }, opts),
                failed: (patch = {}) => stageStore.updateStep(deploymentId, step.seq, { status: 'failed', ...patch }, opts),
            };
        },
        record(action, row = {}, status = 'done') {
            return stageStore.appendStep(deploymentId, { phase, action, status, ...row }, opts);
        },
    };
}

module.exports = { WRITE_ACTIONS, storesOf, makeJournal };
