'use strict';

// What an "All members" save stores for the ids it could not decide itself.
// Split out of featureAccessRoutes.js, which is at its size budget.

const userStore = require('../../stores/userStore');
const { BETA_FEATURES } = require('../../core/entitlements/betaFeatures');

// The org_beta_everyone list to store after an "All members" save. Every
// group-scoped beta the org may currently use is decided by `chosenBeta` (the
// clamped grant). One OUTSIDE the org's access keeps its previous state: the
// admin could not see or toggle it, so a save must not quietly decide it — when
// the plan or menu brings it back it is as it was. A never-chosen list (null)
// counts as "everyone" for that carry-over, matching how buildOrgGrant reads it.
// The scoped ids come from the STATIC beta list, never registry.listCapabilities():
// that one leaves out betas of an inactive platform module, and a save while the
// meetingNotes module is off would then store [] and silently narrow Meeting
// Notes to granted groups once the module is switched on. A stored id that is
// not (or no longer) a group-scoped beta is kept as-is for the same reason.
// "Decided by this save" = in the org's access AND listed in the matrix (the
// filtered list): a beta of an inactive module is not shown, so not chosen.
async function nextBetaEveryone(orgId, bound, chosenBeta, registry) {
    const scopedIds = BETA_FEATURES.filter(f => f.groupScoped).map(f => f.id);
    const scopedSet = new Set(scopedIds);
    const shown = new Set(registry.listCapabilities().map(c => c.id));
    const inBound = new Set((bound.beta || []).filter(id => shown.has(id)));
    const chosen = new Set(chosenBeta);
    const stored = await userStore.getOrgBetaEveryone(orgId);
    const next = [];
    for (const id of scopedIds) {
        if (inBound.has(id)) { if (chosen.has(id)) next.push(id); continue; }
        if (stored == null || stored.includes(id)) next.push(id);
    }
    for (const id of stored || []) if (!scopedSet.has(id) && !next.includes(id)) next.push(id);
    return next;
}

// SELF-HOSTED: the org_everyone_revoked list to store after an "All members"
// save: every matrix-visible togglable core and non-group-scoped beta the org
// may use (inside `bound`, listed by the registry) that is NOT in the chosen
// grant. Group-scoped betas have their own list (nextBetaEveryone). An id this
// save could not decide (outside the org's access menu, or not shown because its
// module is inactive) keeps its previous state, like nextBetaEveryone, so it is
// as the admin left it when the menu or module brings it back. A never-chosen
// list (null) counts as "nothing revoked" for that carry-over.
async function nextEveryoneRevoked(orgId, bound, chosen, registry) {
    const decidable = new Set();
    for (const cap of registry.listCapabilities()) {
        if (!cap.userFacing || !cap.groupTogglable || cap.groupScoped) continue;
        if (cap.kind !== 'core' && cap.kind !== 'beta') continue;
        if ((bound[cap.kind] || []).includes(cap.id)) decidable.add(cap.id);
    }
    const chosenSet = new Set([...(chosen.core || []), ...(chosen.beta || [])]);
    const next = [...decidable].filter(id => !chosenSet.has(id));
    const stored = await userStore.getOrgEveryoneRevoked(orgId);
    for (const id of stored || []) if (!decidable.has(id) && !next.includes(id)) next.push(id);
    return next;
}

module.exports = { nextBetaEveryone, nextEveryoneRevoked };
