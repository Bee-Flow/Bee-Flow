import React from 'react';
import { GitFork } from 'lucide-react';
import StepNodeBase, { NodeChip } from './StepNodeBase';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';

/**
 * The parallel step on the canvas — "do these together instead of one after
 * another".
 *
 * WHY THIS FILE EXISTS. The engine has run `parallel` since the beginning
 * (core/automationRunner/execFlow.js → execParallel), the validator has a full
 * set of rules for it (validate/stepRules/iterationRules.js → checkParallel),
 * portability, the agent catalog and the graph walker all descend into its
 * branches — and the CANVAS had no component for it. React Flow falls back to
 * its own default node for an unregistered type, so a definition carrying a
 * parallel step drew an unstyled grey box with no name, no step number, no run
 * status and no family colour, sitting in the middle of someone's automation.
 * That was not hypothetical: the shipped "New employee onboarding" template
 * (automation/templates.js, id `nc-onboarding`) is a single parallel step with
 * three branches, so every user who started from it opened the builder on a
 * blank box. nodeDefs' PALETTE_ABSENT said so in as many words
 * ("engine-only; no canvas component yet") and the completeness test in
 * flow/nodeDefs.test.js allowed exactly that exemption. This closes it.
 *
 * WHAT THE CARD SAYS. A parallel step holds steps rather than referring to
 * them — its `branches` are inline `Step[][]`, the same relationship a loop has
 * with its `body`. So the two facts a reader needs are the two a bare box
 * cannot give: what it HOLDS (the first step of each branch, by name) and HOW
 * MANY BRANCHES there are, with the one thing that makes this step different
 * from a Condition spelled out — they run at the same time, not one after
 * another. Nothing about the card implies a choice: a Condition picks one way
 * out, a parallel takes all of them.
 *
 * ONE SOURCE PORT, DELIBERATELY. The branches are held, not wired: no edge in
 * the definition points at a branch step, exactly as no edge points into a
 * loop body. Giving this card a port per branch would invite the user to draw
 * edges the runner never reads. The single default handle is the continuation
 * — it fires once every branch has settled, which is what execParallel awaits
 * before returning. It keeps the default (id-less) handle rather than a named
 * one so existing definitions keep their edge anchors untouched.
 *
 * DEFENSIVE BY DESIGN. `branches` is drawn from saved JSON that the validator
 * REPORTS on rather than refuses (`parallel.branches_missing`,
 * `parallel.branch_shape`), so a malformed branch reaches this component while
 * its error sits in the validation pill. A node component that throws takes
 * the whole React Flow tree with it — the canvas would go blank while the pill
 * explained the problem — so every read below tolerates the shapes the
 * validator flags instead of assuming the good one.
 *
 * NO i18n HERE, ON PURPOSE. Like its branch-family siblings (ConditionNode,
 * SwitchNode, FilterNode, GuardNode) this card takes its type label and help
 * through the nodeDefs accessors — which ARE translated, via
 * `automations.node.parallel.*` — and keeps its own summary line in English.
 * LoopNode is the counter-example that translates its summary; when this one
 * follows, the counts below have to move to a key pair per number the way
 * `loop_body_step` / `loop_body_step_plural` did, because `branch${n === 1 ?
 * '' : 'es'}` is grammar written in JavaScript that no dictionary can undo.
 */

// How many branch names fit on one 240px card before the line starts truncating
// mid-word. Three names plus a "+n" tail is what the summary lines on the other
// list-shaped cards (Extract data's fields) settled on.
const MAX_NAMED_BRANCHES = 3;

/** The declared branches, as an array — never null, whatever the JSON holds. */
export function parallelBranches(step) {
    return Array.isArray(step?.branches) ? step.branches : [];
}

/**
 * How many steps this node holds in total, across every branch.
 *
 * A branch that is not an array holds nothing as far as the runner is
 * concerned (execParallel passes `branchSteps || []` into runDag), so it
 * contributes zero rather than making the count unreadable.
 */
export function parallelStepCount(step) {
    return parallelBranches(step).reduce((n, branch) => n + (Array.isArray(branch) ? branch.length : 0), 0);
}

/**
 * The summary line: what the branches hold, then the fact that they run at the
 * same time. The name of the first step of each branch that actually RUNS is
 * what identifies it — a branch has no name of its own, and the step it starts
 * with is how the author thinks of it ("create the folder", "send the
 * welcome").
 *
 * Falls back to the step type's own default label (nodeDefaultLabel) rather
 * than the raw type name, so an unnamed branch head reads "Send a message"
 * instead of "integration_action" — the same jargon nodeDefs exists to keep
 * off the screen.
 */
export function parallelSummary(step) {
    const branches = parallelBranches(step);
    if (branches.length === 0) return { muted: 'no branches yet — nothing runs here' };

    const names = branches.map((branch) => {
        // The head is the first step that RUNS, so a `note` is skipped rather
        // than named. A branch is one of the two places (with a loop body)
        // where edges are synthesized instead of drawn, and execFlow's
        // buildLinearEdges drops notes from that chain on purpose (BFSF-411) —
        // a canvas annotation at the top of a branch is never dispatched. A
        // card that named it would promise "this runs at the same time" about
        // the one step in the branch that never runs at all. The step COUNT
        // below stays raw: it says what the branch HOLDS, the same thing
        // LoopNode's "n steps inside" counts.
        const head = Array.isArray(branch) ? branch.find(s => s && s.type !== 'note') : null;
        if (!head) return 'empty';
        const label = typeof head.label === 'string' ? head.label.trim() : '';
        return label || nodeDefaultLabel(head.type) || 'step';
    });
    const shown = names.slice(0, MAX_NAMED_BRANCHES);
    const rest = names.length - shown.length;
    const held = [...shown, ...(rest > 0 ? [`+${rest}`] : [])].join(' · ');
    return `${held} — all at the same time`;
}

export default function ParallelNode({ id, data }) {
    const { step, runStep, issues, onAddAfter } = data;
    const branches = parallelBranches(step);
    const stepCount = parallelStepCount(step);

    // The count chip carries the fact the summary line has no room for: what
    // happens when one branch fails. execParallel defaults to soft-fail
    // (`failOnAnyBranchError` unset → a failed branch is reported in the
    // step's output and the run carries on), which is the opposite of what
    // most people assume a failing step does, and it is invisible everywhere
    // else on the canvas — a branch that died still leaves this card green.
    const title = branches.length === 0
        ? 'Add branches — each one is a list of steps, and they all run at the same time.'
        : step?.failOnAnyBranchError
            ? `${branches.length} branches run at the same time, holding ${stepCount} step${stepCount === 1 ? '' : 's'}. If any branch fails, this step fails.`
            : `${branches.length} branches run at the same time, holding ${stepCount} step${stepCount === 1 ? '' : 's'}. A branch that fails does not stop the others — the run carries on.`;

    const badges = (
        <NodeChip tone={step?.failOnAnyBranchError ? 'warn' : 'neutral'} title={title}>
            ⇉ {branches.length} branch{branches.length === 1 ? '' : 'es'}
        </NodeChip>
    );

    return (
        <StepNodeBase
            icon={<GitFork size={14} />}
            typeLabel={nodeTypeLabel('parallel')}
            help={nodeHelp('parallel')}
            name={step.label || nodeDefaultLabel('parallel')}
            sub={parallelSummary(step)}
            badges={badges}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
