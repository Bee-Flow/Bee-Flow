// @typecheck strict
/**
 * Automation Routes — REST API for the conversational automation builder.
 *
 *   GET    /catalog                        list apps, actions, triggers, side-effects
 *   GET    /catalog/sample/:tool           sample output for builder hints
 *
 *   GET    /                               list user's automations
 *   POST   /                               create automation (draft or finalised)
 *   POST   /import                         create a draft from an exported envelope
 *   GET    /:id                            get one
 *   GET    /:id/export                     download sanitized portability envelope
 *   PUT    /:id                            update (bumps version when definition changes)
 *   DELETE /:id                            delete
 *   POST   /:id/activate                   set is_active and re-arm next_run_at
 *   POST   /:id/deactivate                 unset is_active
 *   POST   /:id/run                        manual run (live)
 *   POST   /:id/dry-run                    explicit dry-run on demand
 *   GET    /:id/runs                       list runs
 *   GET    /:id/versions                   list saved versions
 *   POST   /:id/webhook                    create a signed webhook URL
 *   GET    /:id/webhooks                   list webhooks for the automation
 *   POST   /:id/form                       create (or return) the hosted form URL
 *   GET    /:id/forms                      list hosted form URLs
 *   GET    /:id/agent-bindings             agents that may call an agent_call automation
 *   PUT    /:id/agent-bindings             set which (editable) agents may call it
 *   POST   /:id/form/:token/rotate         mint a new form URL (old one dies)
 *   DELETE /:id/form/:token                take the form offline
 *
 *   POST   /runs/:id/approve               first-run-confirm flow approve
 *   GET    /runs/:id                       run details
 *   GET    /runs/:id/steps                 per-step log
 *   GET    /runs/:runId/files              files the run produced
 *   GET    /runs/:runId/files/:fileId      download one (?inline=1 for a PDF or image)
 *   GET    /runs/:runId/files/:fileId/preview?page=N   PNG of one PDF page
 *   GET    /runs/:runId/compare/:otherRunId?stepId=    two runs of one automation, step by step
 *   POST   /runs/:runId/golden             mark a successful run as a golden run
 *   DELETE /runs/:runId/golden             unmark it
 *
 *   GET    /:id/test-cases[?stepId=]       test cases of a code step or custom node
 *   GET    /:id/test-cases/:caseId         one case with its input
 *   POST   /:id/test-cases                 create (typed values or a recorded run)
 *   PUT    /:id/test-cases/:caseId         update
 *   DELETE /:id/test-cases/:caseId         delete
 *   POST   /:id/test-cases/run             run the cases (optionally with unsaved code)
 *   GET    /:id/goldens                    golden runs and their last replay
 *   POST   /:id/goldens/replay             replay golden runs in the background
 *   GET    /:id/form-scenarios[/:sid]      saved form answers
 *   POST   /:id/form-scenarios             save from a run
 *   PUT    /:id/form-scenarios/:sid        rename
 *   DELETE /:id/form-scenarios/:sid        delete
 *   POST   /:id/form-scenarios/:sid/dry-run  replay the form journey as a dry run
 *
 *   POST   /webhook/:slug                  PUBLIC inbound webhook (HMAC + nonce)
 *   GET    /form/:token                    PUBLIC hosted-form render config + CSRF
 *   POST   /form/:token/upload             PUBLIC single scanned file for a form
 *   POST   /form/:token                    PUBLIC form submission → one run
 *   POST   /events/gmail                   PUBLIC Gmail Pub/Sub push
 *   POST   /events/msgraph                 PUBLIC MS Graph notification (handles ?validationToken=)
 *   POST   /events/github                  PUBLIC GitHub webhook
 */

// §WS5 #4 — this file is a thin facade. It owns the shared requireAuth + the
// auth/beta/org middleware chain and mounts the per-concern sub-routers in
// automation/ in the SAME order routes were originally registered (Express is
// first-match, so the flattened order is the contract — see
// automation.routetable.test.js).
const express = require('express');
const router = express.Router();

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions');

// ── PUBLIC routes (defined first; auth comes after) ────
router.use(require('./automation/events'));
// The hosted form-trigger surface (`/form/:token`) — anonymous by design; the
// token IS the credential. Same placement rule as events.js.
router.use(require('./automation/formPublic'));

// ── Authenticated routes ───────────────────────────────
router.use(requireAuth);

// All authenticated automation routes are gated behind the 'automations'
// beta feature. Admins toggle this per-organisation in the admin
// dashboard → Security → Beta. Super admins always have access.
const { requireBetaFeature } = require('../core/entitlements/betaFeatures');
router.use(requireBetaFeature('automations'));

// Block all writes when the caller's org is suspended/archived. Public webhook
// routes above this point are intentionally not gated — they're inbound from
// external services and have no session/org context.
const { requireActiveOrgForMutations } = require('../auth');
router.use(requireActiveOrgForMutations());

// Approvals BEFORE crud: crud has GET /:id, and Express is first-match, so
// the /approvals literal must be registered ahead of it (the same rule that
// keeps /templates above /:id inside runs.js).
router.use(require('./automation/approvals'));
router.use(require('./automation/catalog'));
// The code editor's analyze and "Try it" (routes/automation/codeTools.js).
// BEFORE crud: `/code/...` has a literal first segment that /:id would swallow.
router.use(require('./automation/codeTools').makeCodeToolsRouter());
router.use(require('./automation/crud'));
router.use(require('./automation/runs'));
router.use(require('./automation/versions'));
router.use(require('./automation/webhooksAndRunOps'));
// The files a run produced: list, download, PDF page preview (routes/automation/runFiles.js).
router.use(require('./automation/runFiles').makeRunFilesRouter());
// The tables a run produced: a page of rows and a CSV download (routes/automation/runTables.js),
// and the builder's dry preview of a table step (routes/automation/tablePreview.js).
// Tables have their own ledger, so none of this serves a generated file.
router.use(require('./automation/runTables').makeRunTablesRouter());
router.use(require('./automation/tablePreview').makeTablePreviewRouter());
// Handoff 5: who an automation is shared with, and handing it to a new owner.
// Every path has a literal second segment, so position is free.
router.use(require('./automation/sharing').makeSharingRouter());
// Which agents may call an agent_call automation (routes/automation/agentBindings.js).
// Literal second segment, so position is free.
router.use(require('./automation/agentBindings').makeAgentBindingsRouter());
// Handoff 5: the Settings page's Notifications section (read side; the policy
// itself is saved with the definition). Literal second segment too.
router.use(require('./automation/notifications').makeNotificationsRouter());
// Handoff 5: the automation's AI Act check and its "Ready to activate?"
// checklist (routes/automation/aiAct.js). Literal second segments too.
router.use(require('./automation/aiAct').makeAiActRouter());
// Handoff 5: the builder's "Frequently used" (routes/automation/usage.js).
// Literal first segment `_usage`; no earlier GET /:id/steps or /:id/values.
router.use(require('./automation/usage').makeUsageRouter());
// Handoff 5: duplicate, save as template, the description suggestion and the
// header's tab counts (routes/automation/actions.js). Literal second segments.
router.use(require('./automation/actions').makeActionsRouter());
// Phase 9, testing as a product feature. Literal second segments (`test-cases`,
// `goldens`, `form-scenarios`) and `/runs/:runId/compare|golden`, so the
// position is free; they sit last so no earlier first-match route can shadow them.
// Test cases for a code step or a custom node (routes/automation/testCases.js).
router.use(require('./automation/testCases').makeTestCasesRouter());
// Compare two runs of one automation, step by step (routes/automation/runCompare.js).
router.use(require('./automation/runCompare').makeRunCompareRouter());
// Golden runs: mark a good run, replay it later (routes/automation/goldens.js).
router.use(require('./automation/goldens').makeGoldensRouter());
// Saved form answers that replay a form journey as a dry run (routes/automation/formScenarios.js).
router.use(require('./automation/formScenarios').makeFormScenariosRouter());

module.exports = router;
