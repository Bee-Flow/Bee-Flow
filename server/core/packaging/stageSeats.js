// @typecheck
'use strict';

/**
 * Empty the approver seats inside a staged approval chain (`stages[i].approvers`),
 * reporting each stage. The stage itself stays, with an empty seat list: a stage
 * that vanished would silently delete a required approval, whereas an empty one
 * is visibly unconfigured and the installer is asked to pick approvers; the
 * install fills every emptied stage with that pick (resolutions.js). (The
 * installed definition is invalid until they do, and installs inactive/draft.)
 *
 * That holds for the Blueprint and automation-export paths. App Studio template
 * capture canonicalises the scrubbed definition afterwards, and the
 * canonicaliser drops a seatless stage, so there the chain is lost; templateCapture
 * and templatePortability warn about it from the `stages.<key>.approvers` field
 * reported here.
 */
function scrubStageSeats(owner, report, rule, detail) {
    if (!Array.isArray(owner.stages)) return;
    for (const stage of owner.stages) {
        if (!stage || !Array.isArray(stage.approvers) || stage.approvers.length === 0) continue;
        const count = stage.approvers.length;
        stage.approvers = [];
        report.push({ rule, field: `stages.${stage.key || '?'}.approvers`, count, ...detail });
    }
}

module.exports = { scrubStageSeats };
