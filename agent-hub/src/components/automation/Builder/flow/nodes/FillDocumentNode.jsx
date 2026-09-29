import React from 'react';
import { FileSignature } from 'lucide-react';
import StepNodeBase from './StepNodeBase';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';
import { fillDocumentSummary } from '../nodeSummaries';

/**
 * The card for a step that fills a DESIGNED document. Its own icon rather than
 * GenerateDocumentNode's FileText: the two steps sit next to each other in the
 * palette and on the canvas, and telling them apart at a glance is the whole
 * reason a reader looks at a card.
 */
export default function FillDocumentNode({ id, data }) {
    const { step, runStep, issues, onAddAfter } = data;
    return (
        <StepNodeBase
            icon={<FileSignature size={14} />}
            typeLabel={nodeTypeLabel('fill_document')}
            help={nodeHelp('fill_document')}
            name={step.label || nodeDefaultLabel('fill_document')}
            sub={fillDocumentSummary(step)}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
