import { Rows3 } from 'lucide-react';
import type { ComponentType } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';
import { flattenSummary } from '../nodeSummaries';
import StepNodeBaseJs from './StepNodeBase';

// Untyped JS component; its props are checked there.
const StepNodeBase = StepNodeBaseJs as unknown as ComponentType<Record<string, unknown>>;

interface FlattenNodeProps {
    id: string;
    data: {
        step: { label?: string; arrayRef?: string };
        runStep?: unknown;
        issues?: unknown;
        onAddAfter?: unknown;
        stepLabelById?: Map<string, string>;
    };
}

/** The canvas card: "One row per attachment", "Flatten a list", "From Read many ▸ Messages". */
export default function FlattenNode({ id, data }: FlattenNodeProps) {
    const { step, runStep, issues, onAddAfter, stepLabelById } = data;
    const { t } = useTranslation();
    const sub = flattenSummary(step, { stepLabelById, t });
    return (
        <StepNodeBase
            icon={<Rows3 size={14} />}
            typeLabel={nodeTypeLabel('flatten', t)}
            help={nodeHelp('flatten', t)}
            name={step.label || nodeDefaultLabel('flatten', t)}
            sub={sub}
            subTitle={step.arrayRef}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
