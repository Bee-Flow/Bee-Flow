// @typecheck
/**
 * Where an install comes from: established by the server, or claimed by the
 * file. Split out of install.js, which re-exports both names unchanged.
 */

'use strict';

const { readSource } = require('../../../core/packaging/manifest');
const log = require('../../../telemetry/log');

/**
 * Where this install comes from, and with how much authority that is known.
 *
 * Two sources, and the difference between them is the whole reason this
 * function exists rather than three lines in `installBlueprint`:
 *
 *   THE SERVER read the gallery row itself (`blueprintId` + `blueprintOrgId`
 *   come from `resolveManifest`, which ran `canRead` first). That is
 *   established, not claimed.
 *
 *   THE FILE claims something about itself (`manifest.source`). Such a claim
 *   is INPUT FROM OUTSIDE: anyone with a text editor can write
 *   `orgId: 'org_a'` into it.
 *
 * What happens to the two:
 *
 *   1. THE ESTABLISHED ALWAYS WINS. When the server looked a Blueprint up, the
 *      organisation comes from that row and NOT from the file; otherwise a
 *      gallery install would write the file's claim over the server's own
 *      reading.
 *   2. WITHOUT A GALLERY ROW THE CLAIM IS ONLY RECORDED WHEN IT HOLDS. A
 *      forwarded file can only link itself to its Blueprint through
 *      `source.blueprintId`, and without that link no file install counts.
 *      But taking it over UNCHECKED made the install counter a number the
 *      reader could set: whoever had one published file of organisation A
 *      could change `bp_x` into `bp_y` in it and raise the counter of a
 *      Blueprint that was installed zero times. The screen calls that number
 *      a LOWER BOUND, so nudging it upwards is exactly the error that cannot
 *      be allowed.
 *      So the claim has to hold first: `verifyClaimedBlueprint` records it
 *      only when a gallery row with that id exists AND that row carries the
 *      same `solution_key` as this manifest. Then the file demonstrably belongs
 *      to that Blueprint. Recording is still not access: who may see the count
 *      is decided by `requireProjectRole('owner')` on the source project, and
 *      that question does not touch these columns. When the claim does not
 *      hold, or points at nothing, it reads as UNKNOWN, like a deleted
 *      Blueprint.
 *   3. THE VERSION COMES FROM ONE FIELD: `manifest.solution.version`, the same
 *      number every entity stamp carries. `source.version` is a second copy of
 *      that number and is deliberately NOT read here: two numbers that can
 *      differ would produce an install whose project says something other than
 *      its own stamps.
 *
 * Pure and exported, so the hostile cases can be tested on their own.
 */
function provenanceOf({ blueprintId = null, blueprintOrgId = null, manifest = null, claimVerified = false } = {}) {
    const claimed = readSource(manifest);
    const resolvedId = typeof blueprintId === 'string' && blueprintId ? blueprintId : null;
    const resolvedOrg = typeof blueprintOrgId === 'string' && blueprintOrgId ? blueprintOrgId : null;
    const version = Number(manifest?.solution?.version);
    // The claim only counts once somebody checked it. `claimVerified` comes
    // from `verifyClaimedBlueprint`; this function stays pure and reads
    // nothing itself, so the hostile cases can be tested on their own.
    const acceptedClaimId = claimVerified ? claimed.blueprintId : null;
    return {
        installedFromBlueprintId: resolvedId || acceptedClaimId,
        // The organisation belongs to the id: without an accepted id there is
        // no source organisation to record. Otherwise a project would carry
        // the organisation id of another tenant with nothing to back that
        // claim.
        installedFromOrgId: resolvedId ? resolvedOrg : (acceptedClaimId ? claimed.orgId : null),
        installedVersion: Number.isInteger(version) && version > 0 ? version : 1,
    };
}

/**
 * Does the claim this file makes about its own Blueprint hold?
 *
 * One read, one boolean. NOTHING of the gallery row comes out: not the name,
 * not the organisation, not the author, so this check is no read access to a
 * Blueprint of another organisation; it only answers "does this file belong
 * to that id".
 *
 * The comparison is `solution_key`, because that is the only field that binds
 * a Blueprint to a Solution (`sol_<projectId>`, see
 * packaging/manifest.buildManifest), and it cannot be forged without also
 * claiming that the file IS a different Solution.
 *
 * A meta read without the manifest: only `solutionKey` of the gallery row is
 * needed here, and that row can carry megabytes of JSONB.
 *
 * Never throws. When the row cannot be read the claim is NOT verified:
 * unknown narrows, so the install records no provenance.
 */
async function verifyClaimedBlueprint({ claimedId = null, solutionKey = null } = {}) {
    if (typeof claimedId !== 'string' || !claimedId) return false;
    if (typeof solutionKey !== 'string' || !solutionKey) return false;
    try {
        const store = require('../../../stores/blueprintStore');
        const row = await store.getBlueprintById(claimedId, { includeManifest: false });
        return !!row && row.solutionKey === solutionKey;
    } catch (err) {
        log.warn('[Blueprint] could not check a claimed Blueprint id:', /** @type {Error} */ (err).message);
        return false;
    }
}

module.exports = { provenanceOf, verifyClaimedBlueprint };
