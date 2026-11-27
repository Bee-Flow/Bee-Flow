// @typecheck strict
'use strict';
/**
 * The mounts of module "learning" (Learning Center): its rows of the route table of
 * server/index.js, of the static mounts of boot/staticAssets.js and of the /ai router
 * (routes/ai.js), as data (modules/firstParty/contract.js MountRow), with the same gates.
 * Order: the core's (modules/firstParty/order.json "mounts" and "aiMounts"); routers are
 * required at mount time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */

/** @type {MountRow[]} */
const mounts = [
    // Learning Center video pack (LEARN_MEDIA_DIR, outside git and the image).
    // Public, allow-listed file types, a bare 404 on a miss so the SPA renderer
    // never answers for it. See learning/learnMedia.js.
    { key: 'learning:/learn-media', slot: 'static', path: '/learn-media', handlers: () => [require('../learning/learnMedia').createLearnMediaRouter()] },
    // Public certificate verification — unauthenticated `/verify/:token` for a
    // LinkedIn-shareable Bee Flow AI certificate. Token-gated (only certs the owner
    // opted public are resolvable), per-IP rate limited, strict CSP, og:image. Mounted
    // before the SPA catch-all so the SPA doesn't swallow it.
    { key: 'learning:/verify', slot: 'main', path: '/verify', handlers: (g) => [g.requireModule('learning'), require('../routes/verifyCertificate')] },
];

/** @type {MountRow[]} */
const aiMounts = [
    // Academy Custom Courses (Beta) — org-admin authoring CRUD + publish. Must be
    // mounted BEFORE '/learning': router.use('/learning') also matches
    // '/learning/admin/*' paths, so with the other order the learning_center gate
    // and router would intercept admin requests first. Org-admin auth is enforced
    // inside the router (requirePrimaryOrgAdmin).
    { key: 'learning:/learning/admin', path: '/learning/admin', handlers: (g) => [g.requireModule('learning'), g.requireCapability('learning_custom_content'), require('../routes/ai/learningAdmin')] },
    // Learning Center — AI coach (grade/hint), achievements + certificate issuance.
    // Gated on the `learning_center` capability so it can be enabled/disabled per
    // subscription plan. Auth + rate limiting are enforced inside the router.
    //
    // requireModule FIRST on both mounts, per modules/index.js: the capability
    // projection alone answers a de-imported module with 403 feature_locked, which
    // tells the caller the surface exists and they cannot afford it. A module that
    // is not on the instance has to 404 like the other nine — same contract as
    // /verify, which is the same module's public half.
    { key: 'learning:/learning', path: '/learning', handlers: (g) => [g.requireModule('learning'), g.requireCapability('learning_center'), require('../routes/ai/learning')] },
];

module.exports = { mounts, aiMounts };
