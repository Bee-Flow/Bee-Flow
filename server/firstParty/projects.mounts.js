// @typecheck strict
'use strict';
/**
 * The mounts of module "projects": its rows of the route table that the core
 * mounts, as data (modules/firstParty/contract.js MountRow), with the same gates. Order: the
 * core's (modules/firstParty/order.json "mounts"); routers are required at mount time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */

/** @type {MountRow[]} */
const mounts = [
    // The AI that decides by itself when to join a team chat or comment thread:
    // the org policy (members read, admins write) and each person's own opt-out.
    // requireAuth sits on every route of the router.
    { key: 'projects:/api/ai-participation', slot: 'main', path: '/api/ai-participation', handlers: () => [require('../routes/aiParticipation')] },
    // The org switch for co-editing notebooks and pages.
    { key: 'projects:/api/org-collab', slot: 'main', path: '/api/org-collab', handlers: () => [require('../routes/orgCollab')] },
    // Licence gate fires BEFORE the configStore feature gate so a community
    // user sees the actionable `feature_locked` upgrade body rather than the
    // less informative "Projects feature is disabled" string. The configStore
    // gate remains as an operator override for enterprise installs that want
    // to disable Projects per deployment.
    // `requireAuth` fronts the chain so the capability and feature gates never run
    // for an unauthenticated caller, and so the "user still exists in the DB"
    // revalidation applies here as it does on sibling routers. The handlers also
    // self-check `req.session.user.id`, but that was the ONLY thing standing between
    // an anonymous request and the gates — an invariant nothing pinned.
    { key: 'projects:/api/projects', slot: 'main', path: '/api/projects', handlers: (g) => [g.requireModule('projects'), g.requireAuthedUser, g.requireCapability('projects'), g.featureGate('projects', 'Projects'), require('../routes/projects')] },
    // The drain-exempt half of the stage API (design D13): reading a stage, on/off,
    // pause / resume, non-steering values and detach. Deliberately NO module,
    // capability or licence gate: the /api/projects mount above needs `projects`,
    // which sits in the same tier list as `blueprint_packaging`, so a lapse there
    // would strand production. Roles are resolved per route on the stage project
    // itself (projects/stages/stageAuth.js).
    { key: 'projects:/api/solution-stages', slot: 'main', path: '/api/solution-stages', handlers: (g) => [g.requireAuthedUser, require('../routes/solutionStages').makeSolutionStagesDrainRouter()] },
];

module.exports = { mounts };
