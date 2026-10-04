import React from 'react';
import { Box, SquareArrowOutUpRight } from 'lucide-react';
import { nodeHelp, nodeTypeLabel } from '../nodeDefs';
import { humanizeFieldKey } from '../displayHelpers';
import StepNodeBase from './StepNodeBase';
import { useNodeRuntime } from '../NodeRuntimeContext';
import { STEP_NODE_DEFAULT } from '../stepMeta';

/**
 * A "call_block" node — runs a reusable Step (a standalone kind='block' row)
 * as a single step in this automation. Shows the Step label + mapped inputs
 * and an "Open Step" affordance (deep-link to the Step builder) when the
 * editor provides onOpenBlock via NodeRuntimeContext.
 */
export default function CallStepNode({ id, data }) {
    const { step, runStep, issues, onAddAfter } = data;
    const { onOpenBlock, blockSummaries } = useNodeRuntime();
    const inputs = step.inputs && typeof step.inputs === 'object' ? Object.keys(step.inputs) : [];
    const summary = step.blockId ? (blockSummaries?.[step.blockId] || '') : '';
    const { sub, subTitle } = describeCall(summary, inputs);

    const badges = (onOpenBlock && step.blockId) ? (
        <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpenBlock(step.blockId); }}
            onMouseDown={(e) => e.stopPropagation()}
            aria-label="Open Step"
            title="Open this Step in its own builder"
            className="h-5 w-5 rounded-md flex items-center justify-center text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
        >
            <SquareArrowOutUpRight size={11} />
        </button>
    ) : null;

    return (
        <StepNodeBase
            icon={<Box size={14} />}
            typeLabel={nodeTypeLabel('call_block')}
            help={nodeHelp('call_block')}
            name={step.label || STEP_NODE_DEFAULT}
            sub={sub}
            subTitle={subTitle}
            badges={badges}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}

/**
 * The card's summary line and the tooltip behind it.
 *
 * The card shows the sentence, the tooltip keeps the exact value — the same
 * demote-never-delete move the Condition and Filter cards make. A reusable
 * Step's parameter keys are written by whoever built it (`klant_naam`,
 * `bedrag`), and the card printed them raw, so the only group in the builder
 * whose contents are authored in-house was also the only one that read like a
 * payload. Humanised they say the same thing to the colleague who inherits
 * the automation.
 *
 * The raw keys move into the card's `title`, IN FULL and uncut: they are what
 * the mapping is actually written in, the tooltip has room the 240px card
 * does not, and truncating the one place the exact value survives would cap
 * precisely the reader it is kept for.
 *
 * What the Step is FOR beats how many things it takes — an arity never said
 * what a Step does, on the card any more than in the palette. When both are
 * known they share the line, the way a flowlet's card does.
 *
 * It lives out here rather than in the component because composing two facts
 * into two strings is four branches on its own, and inlined it pushed
 * CallStepNode past the complexity ceiling eslint holds every node file to.
 */
function describeCall(summary, inputs) {
    const count = (n) => `${n} input${n === 1 ? '' : 's'}`;
    const inputsText = inputs.length === 0
        ? null
        : `${count(inputs.length)}: ${inputs.slice(0, 4).map(humanizeFieldKey).join(', ')}${inputs.length > 4 ? '…' : ''}`;
    const rawInputsText = inputs.length === 0 ? null : `${count(inputs.length)}: ${inputs.join(', ')}`;
    const sub = summary
        ? (inputsText ? `${summary} · ${inputsText}` : summary)
        : (inputsText || { muted: 'no inputs mapped' });
    return { sub, subTitle: [summary, rawInputsText].filter(Boolean).join(' · ') || undefined };
}
