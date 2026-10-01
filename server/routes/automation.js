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
 *   POST   /:id/upgrade-mappings           upgrade stored mappings to picks (?dryRun=1: preview)
 *   GET    /:id/runs                       list runs
 *   GET    /:id/versions                   list saved versions
 *   POST   /:id/webhook                    create a signed webhook URL
 *   GET    /:id/webhooks                   list webhooks for the automation
 *   POST   /:id/form                       create (or return) the hosted form URL
 *   GET    /:id/forms                      list hosted form URLs
 *   POST   /:id/form/:token/rotate         mint a new form URL (old one dies)
 *   DELETE /:id/form/:token                take the form offline
 *
 *   POST   /runs/:id/approve               first-run-confirm flow approve
 *   GET    /runs/:id                       run details
 *   GET    /runs/:id/steps                 per-step log
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
// Handoff 5: who a routine is shared with, and handing it to a new owner.
// Every path has a literal second segment, so position is free.
router.use(require('./automation/sharing').makeSharingRouter());
// Handoff 5: the Settings page's Notifications section (read side; the policy
// itself is saved with the definition). Literal second segment too.
router.use(require('./automation/notifications').makeNotificationsRouter());
// Handoff 5: the routine's AI Act check and its "Ready to activate?"
// checklist (routes/automation/aiAct.js). Literal second segments too.
router.use(require('./automation/aiAct').makeAiActRouter());
// Handoff 5: the builder's "Frequently used" (routes/automation/usage.js).
// Literal first segment `_usage`; no earlier GET /:id/steps or /:id/values.
router.use(require('./automation/usage').makeUsageRouter());
// Handoff 5: duplicate, save as template, the description suggestion and the
// header's tab counts (routes/automation/actions.js). Literal second segments.
router.use(require('./automation/actions').makeActionsRouter());
// "Koppelingen bijwerken": upgrade the stored mappings to picks where the
// value stays the same (routes/automation/upgradeMappings.js). Literal second
// segment too.
router.use(require('./automation/upgradeMappings').makeUpgradeMappingsRouter());

module.exports = router;
