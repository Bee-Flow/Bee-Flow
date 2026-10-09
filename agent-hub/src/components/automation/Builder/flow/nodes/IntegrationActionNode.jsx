import React from 'react';
import { Wrench, Zap, Repeat } from 'lucide-react';
import { nodeHelp, nodeTypeLabel } from '../nodeDefs';
import StepNodeBase, { NodeChip } from './StepNodeBase';
import IntegrationLogo from './IntegrationLogo';
import { humanizeToolName } from '../displayHelpers';
import { useTranslation } from '../../../../../hooks/useTranslation';

/**
 * Fallback side-effect heuristic for legacy steps that predate the catalog
 * `sideEffect` flag (which is now plumbed onto the step — see step.sideEffect
 * below, sourced from server/automation/sideEffectMap.js). Match verbs on
 * TOKEN boundaries, not as substrings, so e.g. `gmail_read_attachment` (token
 * "attachment", not "attach") is correctly read-only while `drive_create_folder`
 * (token "create") still flags.
 */
const SIDE_EFFECT_VERBS = new Set([
    'send', 'compose', 'create', 'update', 'delete', 'post',
    'add', 'remove', 'move', 'share', 'set', 'reply', 'forward',
    'attach', 'write',
    // gmail_modify_labels / gmail_bulk_modify, gmail_archive, gmail_mark_read. Not
    // 'trash': nextcloud_list_trash only reads.
    'modify', 'archive', 'mark',
]);
export function looksLikeSideEffect(toolName) {
    if (!toolName) return false;
    return String(toolName).split(/[_.]/).some(tok => SIDE_EFFECT_VERBS.has(tok));
}

export default function IntegrationActionNode({ id, data }) {
    const { t } = useTranslation();
    const { step, runStep, issues, onAddAfter } = data;
    const tool = step.tool || 'unknown_tool';
    const sideEffect = step.sideEffect ?? looksLikeSideEffect(tool);
    const friendlyTool = humanizeToolName(tool);
    const iterates = !!step.forEach?.overRef;

    const badges = (sideEffect || iterates) ? (
        <>
            {iterates && (
                <NodeChip tone="accent" title={`Runs once per item in ${step.forEach.overRef}`}>
                    <Repeat size={10} /> {t('automations.integration_action_node.for_each', 'for each')}
                </NodeChip>
            )}
            {sideEffect && (
                <NodeChip tone="warn" title={t('automations.integration_action_node.this_step_writes_sends_runs_are', 'This step writes/sends — runs are skipped in dry-run.')}>
                    <Zap size={10} />
                </NodeChip>
            )}
        </>
    ) : null;

    return (
        <StepNodeBase
            icon={<IntegrationLogo tool={tool} size={16} fallback={<Wrench size={14} />} />}
            typeLabel={nodeTypeLabel('integration_action')}
            help={nodeHelp('integration_action')}
            name={step.label || friendlyTool}
            sub={friendlyTool}
            subTitle={tool}
            badges={badges}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
