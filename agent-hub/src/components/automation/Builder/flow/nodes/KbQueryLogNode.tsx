import { ScrollText } from 'lucide-react';
import StepNodeBase from './StepNodeBase';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';
import type { StepNodeData } from './nodeProps';

/** The knowledge base query log step (read or review), as a plain card. The real editor is a later package. */
interface KbQueryLogNodeProps {
    data: StepNodeData;
    id: string | null;
}

export default function KbQueryLogNode({ id, data }: KbQueryLogNodeProps) {
    const { step, runStep, issues, onAddAfter, kbNameById } = data;
    return (
        <StepNodeBase
            icon={<ScrollText size={14} />}
            typeLabel={nodeTypeLabel('kb_query_log')}
            help={nodeHelp('kb_query_log')}
            name={step.label || nodeDefaultLabel('kb_query_log')}
            sub={kbNameById?.[step.knowledgeBaseId as string] || ''}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
