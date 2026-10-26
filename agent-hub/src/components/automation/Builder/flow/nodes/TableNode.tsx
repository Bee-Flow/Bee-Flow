import { TableProperties } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';
import { tableSummary } from '../tableSummaries';
import StepNodeBaseJs from './StepNodeBase';
import type { StepNodeData } from './nodeProps';

const StepNodeBase = StepNodeBaseJs;

interface Props {
    id: string;
    data: StepNodeData;
}

/** The canvas card of "Edit table": how many steps it has and the first two by name. */
export default function TableNode({ id, data }: Props) {
    const { step, runStep, issues, onAddAfter } = data;
    const { t } = useTranslation();
    return (
        <StepNodeBase
            icon={<TableProperties size={14} />}
            typeLabel={nodeTypeLabel('table', t)}
            help={nodeHelp('table', t)}
            name={step.label || nodeDefaultLabel('table', t)}
            sub={tableSummary(step, t)}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
