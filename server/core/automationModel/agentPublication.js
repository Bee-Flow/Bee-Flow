// @typecheck
/**
 * Does this agent row run on its PUBLISHED config?
 *
 * Pure, so the automation runner (core/automationRunner/aiStepAgent.js) and
 * the automation feature (automation/agentCatalog.js, agentPickerRows.js)
 * answer it the same way.
 *
 * ── TWO SWITCHES, ONE CLAIM ─────────────────────────────────────────
 * `is_published` is the SHARING switch: it puts the agent in the library
 * (`setAgentPublished`, stores/agent/agentCrud.js). WHICH config runs is
 * decided elsewhere — `isSplitActive`: `published_version > 0` and a
 * `published_config` that exists. The two are independent: publishing to the
 * library does not touch `published_version`, `publishAgentVersion` is a
 * separate action, and the backfill deliberately does not run at boot.
 * `is_published = TRUE` with `published_version = 0` is therefore an ordinary
 * state, and then `getForRuntime` serves the LIVE draft config
 * (`runtimeSource: 'live'`).
 *
 * For the OWNER that is fine — they know their own draft. For anyone else it
 * is not: an unattended automation would run on a colleague's in-progress
 * `config.tools` (exactly the per-action grants the whole derivation in
 * `core/automationRunner/aiStepAgent.js` rests on), their draft knowledge
 * bases and their draft prompt — and every autosave in the agent editor would
 * immediately change what happens tonight in someone else's account, with no
 * version and no review. Publishing is what makes an agent something another
 * person can build on; then it must also be the published config that runs.
 *
 * `runtimeSource` is the answer `getForRuntime` and `getPublishedAgentsForUser`
 * send along themselves. A row from `getAgents` does not carry that field but
 * does carry `published_version`; that then counts. When both are missing
 * there is no evidence of a publication — and unknown narrows.
 */

'use strict';

function servesPublishedConfig(agent) {
    if (!agent) return false;
    if (typeof agent.runtimeSource === 'string') return agent.runtimeSource === 'published';
    return Number(agent.published_version) > 0;
}

module.exports = { servesPublishedConfig };
