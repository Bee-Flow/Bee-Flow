import React from 'react';
import { FileText } from 'lucide-react';
import StepNodeBase from './StepNodeBase';
import { generateDocumentSummary } from '../nodeSummaries';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';

export default function GenerateDocumentNode({ id, data }) {
    const { step, runStep, issues, onAddAfter } = data;
    return (
        <StepNodeBase
            icon={<FileText size={14} />}
            typeLabel={nodeTypeLabel('generate_document')}
            help={nodeHelp('generate_document')}
            name={step.label || nodeDefaultLabel('generate_document')}
            sub={generateDocumentSummary(step)}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
