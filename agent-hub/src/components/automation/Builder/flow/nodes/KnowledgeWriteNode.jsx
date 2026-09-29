import { BookOpen } from 'lucide-react';
import React from 'react';
import StepNodeBase, { NodeChip } from './StepNodeBase';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';
import { knowledgeWriteSummary } from '../nodeSummaries';

/**
 * A write into a knowledge base.
 *
 * Two badges, and both answer a question the author cannot get from the canvas
 * any other way:
 *
 *   writes   — like the datatable card. The effect outlives the run, and here
 *              it goes further: an agent will later state this text as fact,
 *              with a citation.
 *   repeats  — there is no source reference, so every run leaves ANOTHER
 *              document rather than replacing its own. On a nightly routine
 *              that is a knowledge base nobody can explain the size of six
 *              months later, and the validator's warning is easy to dismiss
 *              once. On the card it stays visible.
 */
export default function KnowledgeWriteNode({ id, data }) {
    const { step, runStep, issues, onAddAfter, kbNameById } = data;
    const repeats = !String(step.sourceUri || '').trim();

    const badges = (
        <>
            <NodeChip tone="warn" title="This step adds to a knowledge base — an agent will answer from it afterwards.">writes</NodeChip>
            {repeats && (
                <NodeChip
                    tone="warn"
                    title="No source reference, so every run adds another document instead of replacing its own."
                >repeats</NodeChip>
            )}
        </>
    );

    return (
        <StepNodeBase
            icon={<BookOpen size={14} />}
            typeLabel={nodeTypeLabel('knowledge_write')}
            help={nodeHelp('knowledge_write')}
            name={step.label || nodeDefaultLabel('knowledge_write')}
            sub={knowledgeWriteSummary(step, { kbNameById })}
            subTitle={kbNameById?.[step.knowledgeBaseId] || step.knowledgeBaseId}
            badges={badges}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
