import { FileSpreadsheet } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';
import { readTableSummary } from '../tableSummaries';
import StepNodeBaseJs from './StepNodeBase';
import type { StepNodeData } from './nodeProps';

const StepNodeBase = StepNodeBaseJs;

interface Props {
    id: string;
    data: StepNodeData;
}

/** The canvas card of "Read table": which sheets it opens, or that no file is chosen yet. */
export default function ReadTableNode({ id, data }: Props) {
    const { step, runStep, issues, onAddAfter } = data;
    const { t } = useTranslation();
    return (
        <StepNodeBase
            icon={<FileSpreadsheet size={14} />}
            typeLabel={nodeTypeLabel('read_table', t)}
            help={nodeHelp('read_table', t)}
            name={step.label || nodeDefaultLabel('read_table', t)}
            sub={readTableSummary(step, t)}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
