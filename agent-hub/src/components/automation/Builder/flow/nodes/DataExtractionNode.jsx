import React from 'react';
import { ScanText } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';
import { dataExtractionSummary } from '../nodeSummaries';
import StepNodeBase, { NodeChip, ForEachBadge } from './StepNodeBase';

/**
 * The Extract data card. Same chrome as the AI step (it is the AI family's
 * other member), minus the tools port: this step calls no tools and picks no
 * tier — it runs on the one extraction model the admin configured. What the
 * card can tell you at a glance is how many fields it pulls out and which.
 */
export default function DataExtractionNode({ id, data }) {
    const { step, runStep, issues, onAddAfter } = data;
    const { t } = useTranslation();
    const fieldCount = Array.isArray(step.fields)
        ? step.fields.filter(f => f && typeof f.name === 'string' && f.name.trim()).length
        : 0;
    const badges = (
        <>
            <ForEachBadge step={step} />
            {fieldCount > 0 && (
                <NodeChip tone="accent" title={t('routines.ndv.extraction.fields', 'Fields to extract')}>
                    {t('routines.ndv.extraction.count', '{n} fields', { n: fieldCount })}
                </NodeChip>
            )}
        </>
    );
    return (
        <StepNodeBase
            icon={<ScanText size={14} />}
            typeLabel={nodeTypeLabel('data_extraction', t)}
            help={nodeHelp('data_extraction', t)}
            name={step.label || nodeDefaultLabel('data_extraction', t)}
            sub={dataExtractionSummary(step)}
            badges={badges}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
