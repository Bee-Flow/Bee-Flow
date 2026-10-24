import { AppWindow } from 'lucide-react';
import React from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';
import StepNodeBase from './StepNodeBase';
import type { StepNodeProps } from './nodeProps';

/**
 * "Back to the app": the run ends here and the Studio App is told what to do
 * next: which screen to open, what to say, what to refresh.
 *
 * TERMINAL, and that is what this card must radiate. Like StopErrorNode, it does NOT pass on
 * `onAddAfter` and sets `sourceConnectable={false}`: no "+" button, no draggable exit.
 * Leaving that out is the whole rule. The MECHANISM sits in StepNodeBase (`onAddAfter && …`,
 * `isConnectable={sourceConnectable}`), and that file names no step type at all.
 *
 * Existing outgoing edges (from JSON/AI authoring or from a converted step) still render and
 * remain removable. Only NEW connections are refused, exactly as with Stop-and-Error.
 *
 * No `tone`: StepNodeBase knows exactly one (`error`, the red end card of Stop-and-Error), and
 * this is the good ending of an automation started by a button. The card therefore carries the
 * ordinary colour of its family (`end`); passing 'success' would be a prop that is read nowhere.
 */
export default function ReturnToAppNode({ id, data }: StepNodeProps) {
    const { t } = useTranslation();
    const { step, runStep, issues } = data;
    // What is on the card is what HAPPENS when the run ends here, in the order in which the
    // visitor notices it: first the notification, then the screen. The toast and the screen id
    // are the AUTHOR's words and stay as he typed them; only what the card adds itself goes
    // through t().
    const nav = step.navigateTo && typeof step.navigateTo === 'object' ? step.navigateTo : null;
    const parts = [];
    if (step.toast && step.toast.message) parts.push(String(step.toast.message));
    if (nav && nav.screenId) parts.push(`→ ${nav.screenId}`);
    if (step.refresh) {
        parts.push(step.refresh === 'resetForm'
            ? t('automations.node.return_to_app.card_resets_form', 'clears the form')
            : t('automations.node.return_to_app.card_reloads_data', 'reloads the data'));
    }
    const sub = parts.length
        ? parts.join(' · ')
        : { muted: t('automations.node.return_to_app.card_empty', 'tells the app nothing yet') };

    return (
        <StepNodeBase
            icon={<AppWindow size={14} />}
            typeLabel={nodeTypeLabel('return_to_app')}
            help={nodeHelp('return_to_app')}
            name={step.label || nodeDefaultLabel('return_to_app')}
            sub={sub}
            subTitle={parts.length ? parts.join(' · ') : undefined}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            sourceConnectable={false}
        />
    );
}
