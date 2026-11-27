// @typecheck strict
/**
 * Tenant-isolation fixtures — one entry per resource kind the matrix test
 * (tenantIsolation.matrix.test.js) drives: how to create one in an org, and
 * which routes look it up by id.
 *
 * The matrix creates every kind in org B as user B, then calls each route as
 * user A of org A with B's id and expects 403 or 404; it also calls the first
 * route as B and expects 200, so a kind whose routes refuse everyone cannot
 * pass by accident.
 *
 * A kind names its router and mount so the test serves the REAL router behind
 * the real gates (testUtils/routeHarness.js serve): the only thing the harness
 * supplies is the session, exactly what express-session would.
 *
 * Adding a kind: `create` returns the id; `routes` lists `METHOD /mounted/path/:id`
 * exactly as auth/routes.contract.json spells them, with `:id` as the hole;
 * `router()` requires the router lazily (the stores must be initialised on the
 * PGlite pool first, which the test does).
 *
 * `orgAdminCaller: true` also runs the kind's routes as a second caller: the
 * organisation admin of org A who is a plain member of a group of org B. That
 * person belongs to org B but does not administer it, so every route must
 * still answer 403 or 404. Set it on kinds whose routes are gated on
 * org-admin; kinds gated on a flat permission are outside it.
 *
 * The kinds sit in testUtils/tenantFixtures/, one file per area, and a module's
 * kinds in a file that module owns (scripts/module-map.json). This file lists
 * that directory over every root (moduleRoots.cjs listTreeDir), so a module that
 * is not here contributes no kind and nothing of it is required. KIND_ORDER
 * keeps the order the matrix creates the kinds in, which matters: a kind may
 * change org B on its way (its owner made org B's admin, a member added) before
 * the next one is created. A kind it does not name comes after the named ones,
 * by file name.
 *
 * tenantIsolation.exemptions.json lists the routes with a parameter that no kind
 * covers yet, with a reason; lint:tenant-matrix-ratchet keeps that list from
 * growing.
 */

'use strict';

const { listTreeDir } = require('../moduleRoots.cjs');

/**
 * @typedef {{
 *   kind: string,
 *   mount: string,
 *   router: () => import('express').Router,
 *   create: (ctx: { orgId: string, userId: string, index: number, outsiderId?: string }) => Promise<string>,
 *   routes: string[],
 *   bodies?: Record<string, unknown>,
 *   params?: Record<string, string>,
 *   queries?: Record<string, string>,
 *   ownerStatus?: number,
 *   ownerStatusWithout?: Record<string, number>,
 *   orgAdminCaller?: boolean,
 * }} TenantFixture
 *   `bodies`: per route, the body a member of org A sends where the schema is
 *   validated before the gate (an empty one would be the 400 of the schema, not
 *   the gate's answer).
 *   `params`: a fixed value for a named path parameter (every other one is the
 *   kind's id), where a sub-resource is named by a word such as `current`.
 *   `queries`: per route, a query string its schema requires before the gate.
 *   `ownerStatusWithout`: the owner's status when the named first-party module is not loaded (a
 *   core route whose answer past the gate comes from that module, e.g. its 409 `module_absent`).
 */

/** Every kind of today, in the order the matrix creates them. */
const KIND_ORDER = [
    'agent', 'versions', 'webpage', 'automation', 'automationRun', 'automationApproval', 'automationBuilderSession',
    'automationFolder', 'automationTemplate', 'automationByAgent', 'automationForm', 'datatable', 'notebook', 'notebookLibrary',
    'project', 'solution', 'solutionStage', 'blueprint', 'studioApp', 'studioAppRuntime', 'studioAppFiles', 'studioAppRunLog',
    'studioAppTriggers', 'studioAppAiCapabilities', 'studioAppWebhook', 'studioAppCore', 'studioAppTemplate',
    'studioAppBuilderSession', 'studioDocument', 'studioDocumentRestore', 'studioDocumentArchived', 'studioSheet',
    'studioDocumentFolder', 'knowledgeBase', 'kbCategory', 'kbQueryLogSubject', 'orgUser', 'organization', 'coworkShield',
    'coworkShieldAdmin', 'coworkPolicy', 'coworkPolicyAdmin', 'orgPrivacyShield', 'orgPrivacyShieldAdmin', 'orgAiContext',
    'orgAiContextAdmin', 'orgMemoryAdmin', 'aiParticipation', 'aiParticipationAdmin', 'orgCollab', 'orgCollabAdmin',
    'orgAutomationImageAi', 'orgAutomationImageAiAdmin', 'orgIntegrationCache', 'orgIntegrationCacheAdmin', 'orgAzureConfigAdmin',
    'houseStyles', 'houseStylesAdmin', 'orgSubscription', 'orgSubscriptionAdmin', 'customIntegrationsAdmin', 'talkNotesSettings',
    'talkNotesSettingsAdmin', 'gmeetNotesSettings', 'gmeetNotesSettingsAdmin', 'teamsNotesSettings', 'teamsNotesSettingsAdmin',
    'voiceprints', 'voiceprintsAdmin', 'transcription', 'skill', 'step', 'coworkSchedule', 'reminder', 'notification', 'iconPack',
    'mcpToken', 'summaryTemplate', 'playbook', 'integrationConnection', 'coworkTemplate', 'coworkDesk', 'directConversation',
    'chatLabel', 'memory', 'agentCategory', 'dpiaAgent', 'aiActAgent', 'ropaProject', 'complianceIncident', 'isoRisk', 'isoAudit',
    'isoNonconformity', 'isoObjective', 'isoObligation', 'customFramework', 'customCheck', 'dsrRequest', 'supportInbox',
    'supportInboxThread', 'supportInboxCanned', 'supportInboxTag', 'supportTicket', 'orgGroup', 'orgInvitation', 'orgConnector',
    'ncPairingCode', 'ncPendingBinding', 'securityKey',
];

/**
 * The kinds of every file of testUtils/tenantFixtures/ that is here (a file without FIXTURES, such as
 * helpers.js, adds none), in KIND_ORDER.
 * @returns {TenantFixture[]}
 */
function discoverFixtures() {
    const found = listTreeDir('testUtils', 'tenantFixtures')
        .filter((e) => e.name.endsWith('.js') && !e.name.endsWith('.test.js'))
        .flatMap((e) => /** @type {{ FIXTURES?: TenantFixture[] }} */ (require(e.abs)).FIXTURES || []);
    const rank = (/** @type {TenantFixture} */ f) => (KIND_ORDER.includes(f.kind) ? KIND_ORDER.indexOf(f.kind) : KIND_ORDER.length);
    return found.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i).map(({ f }) => f);
}

/**
 * The routes the kinds of a module that is not here would drive: the 'METHOD /path' literals of
 * every kind file in testUtils/tenantFixtures/ of every root that listTreeDir leaves out (a hidden
 * module's). Read as text: such a file is not required. Empty when every module is here.
 * @returns {Set<string>}
 */
function routesOfAbsentKinds() {
    const fs = require('node:fs');
    const { walkServerTree } = require('./serverTree');
    const here = new Set(listTreeDir('testUtils', 'tenantFixtures').map((e) => e.abs));
    /** @type {Set<string>} */
    const out = new Set();
    for (const f of walkServerTree({ under: 'testUtils/tenantFixtures' })) {
        if (here.has(f.abs) || !f.treePath.endsWith('.js') || f.treePath.endsWith('.test.js')) continue;
        for (const m of fs.readFileSync(f.abs, 'utf8').matchAll(/'((?:GET|POST|PUT|PATCH|DELETE) \/[^'\s]*)'/g)) out.add(/** @type {string} */ (m[1]));
    }
    return out;
}

/** @type {TenantFixture[]} */
const FIXTURES = discoverFixtures();

module.exports = { FIXTURES, KIND_ORDER, routesOfAbsentKinds };
