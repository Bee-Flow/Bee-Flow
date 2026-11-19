import { FileDown } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';
import { writeTableSummary } from '../tableSummaries';
import StepNodeBase from './StepNodeBase';
import type { StepNodeData } from './nodeProps';

interface Props {
    id: string;
    data: StepNodeData;
}

/** The canvas card of "Write table": the file type it writes, or that no table is chosen yet. */
export default function WriteTableNode({ id, data }: Props) {
    const { step, runStep, issues, onAddAfter } = data;
    const { t } = useTranslation();
    return (
        <StepNodeBase
            icon={<FileDown size={14} />}
            typeLabel={nodeTypeLabel('write_table', t)}
            help={nodeHelp('write_table', t)}
            name={step.label || nodeDefaultLabel('write_table', t)}
            sub={writeTableSummary(step, t)}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
