import React from 'react';
import { ClipboardList, CheckCircle2, Clock } from 'lucide-react';
import { nodeHelp, nodeTypeLabel } from '../nodeDefs';
import StepNodeBase, { NodeChip } from './StepNodeBase';

/** 900 → "15 min", 3600 → "1 hour", 604800 → "7 days". */
function humanWait(seconds) {
    const s = Number(seconds) || 3600;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    if (s < 86400) return `${Math.round(s / 3600)} hour${s >= 7200 ? 's' : ''}`;
    return `${Math.round(s / 86400)} day${s >= 172800 ? 's' : ''}`;
}

/**
 * A further page of the routine's public form, shown on the SAME /f/<token>
 * URL the visitor is already on.
 *
 *   input  — the run PAUSES here until the visitor answers. Worth showing the
 *            wait window on the canvas: it is the only step whose duration is
 *            bounded by a person rather than by the routine.
 *   ending — the closing page (typically a summary). It does not pause.
 */
export default function FormPageNode({ id, data }) {
    const { step, runStep, issues, onAddAfter } = data;
    const isEnding = step.mode === 'ending';
    const fields = Array.isArray(step.form?.fields) ? step.form.fields : [];
    const title = step.form?.title || (isEnding ? 'All done' : 'Form page');
    const sub = isEnding ? title : `${title} · ${fields.length} question${fields.length === 1 ? '' : 's'}`;

    const badges = isEnding ? null : (
        <NodeChip title={`The routine waits up to ${humanWait(step.waitSeconds)} for the visitor to answer.`}>
            <Clock size={10} />
        </NodeChip>
    );

    return (
        <StepNodeBase
            icon={isEnding ? <CheckCircle2 size={14} /> : <ClipboardList size={14} />}
            typeLabel={nodeTypeLabel('form_page')}
            help={nodeHelp('form_page')}
            name={step.label || (isEnding ? 'Closing page' : 'Ask for more info')}
            sub={sub}
            badges={badges}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
