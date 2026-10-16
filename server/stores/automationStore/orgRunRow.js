// @typecheck
/**
 * The organisation-wide run row, split out of runs.js (its doc comment below is
 * the contract). runs.js maps the SQL row first (rowToRunWithAutomation) and
 * hands the result to projectOrgRun.
 */

'use strict';

/**
 * The ORG-scoped row (Track H2) — an EXPLICIT ALLOW-LIST, not rowToRun minus a
 * field, and that distinction is the whole reason this function exists.
 *
 * rowToRun maps `triggerPayload`: the data a run STARTED with. For your own
 * runs that is yours — it is the form you filled in, the mail that arrived. In
 * an organisation-wide list it is a COLLEAGUE'S: every submission of every
 * published form, every inbound e-mail body, name, address and attachment
 * reference in the organisation, shipped to the browser of anyone holding
 * manage_automations — for a table that renders none of it. It also carries
 * `awaitingStepExpiresAt`, `cancelRequested` and the rest of the runner's
 * plumbing, which the list has no use for either.
 *
 * So this builds the row from the fields the executions table actually reads
 * (ExecutionsTable.jsx + runLanguage.js), one by one. Removing keys from
 * rowToRun instead would work exactly once: the next column somebody adds to
 * automation_runs would start travelling the day it is added, and nothing
 * would say so. CLAUDE.md draws the same line for outbound payloads; the
 * reasoning is identical when the "outside" is another person's data.
 *
 * `mine` is the viewer's own ownership of the run, computed here and checked
 * FOR TRUE by the client. The raw `userId` deliberately does NOT travel: the
 * list shows what ran, not who ran it, and an owner id is one join away from a
 * name the screen never asked for.
 *
 * WHAT IS ON THE LIST BY DECISION, not by accident: `summary` and `error`.
 * They are a run's own free text and can quote whatever the run touched, so
 * including them in an organisation-wide read is a real choice and is made
 * here rather than left implicit. It follows GET /approvals?scope=org, which
 * hands an org admin the approval `prompt` under the same shape of check, and
 * it is what the surface is FOR: an admin who can see that something broke but
 * not what broke cannot act on it. Two things keep it bounded — the
 * permission, and the fact that the strip above the table (nowRunning.js)
 * summarises by error CLASS only, so the free text appears in the log rather
 * than in the glance. If a later stage wants the tighter reading, the change
 * is to drop these two fields from THIS list and leave the class behind; the
 * run itself stays reachable by its owner either way.
 */
function projectOrgRun(full, viewerUserId = null) {
    // A run on the starter's own connections shows no summary or error text to
    // anybody else (automation/callerRunVisibility.js).
    const hidden = !require('../../core/automationModel/callerRunVisibility').canReadRunData(full, viewerUserId);
    return {
        id: full.id,
        journeyRunId: full.journeyRunId ?? null,
        automationId: full.automationId,
        automationTitle: full.automationTitle,
        automationKind: full.automationKind,
        automationIcon: full.automationIcon,
        automationTriggerType: full.automationTriggerType,
        rootStepId: full.rootStepId,
        rootTriggerLabel: full.rootTriggerLabel,
        triggerKind: full.triggerKind,
        mode: full.mode,
        status: full.status,
        startedAt: full.startedAt,
        finishedAt: full.finishedAt,
        durationMs: full.durationMs,
        summary: hidden ? null : (full.summary ?? null),
        error: hidden ? null : (full.error ?? null),
        errorClass: full.errorClass ?? null,
        handledErrorCount: full.handledErrorCount ?? 0,
        // Handoff 5: which version ran, whether it was a test, and the outcome
        // with its data-derived params (folder, file name, values) left out.
        version: full.version ?? null,
        isTest: !!full.isTest,
        outcome: hidden ? null : require('../../automation/runOutcome').outcomeForOrgRow(full.outcome),
        // Ownership, not identity. Only ever true for a real match: a null
        // viewer (or a null owner) is "not mine", never "probably fine".
        mine: !!(viewerUserId && full.userId && String(full.userId) === String(viewerUserId)),
    };
}

module.exports = { projectOrgRun };
