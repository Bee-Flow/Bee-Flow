import { Sparkles, Hammer, Bot, Zap } from 'lucide-react';
import React from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
import { TOOL_HANDLE_ID, toolStateOf, aiStepPortCounts, aiStepCardText } from '../aiToolNodes';
import { nodeHelp, nodeTypeLabel } from '../nodeDefs';
import AiStepPorts from './AiStepPorts';
import StepNodeBase, { NodeChip, ForEachBadge } from './StepNodeBase';

const VARIANT_ICON = { agent: Bot, skill: Zap, instruction: Sparkles };

/** The tool port's label: an invitation on a bare step, a count otherwise. */
function toolPortLabel(toolState, variant, toolCount, t) {
    if (toolState.mode !== 'none') return `tools · ${toolCount || 'all'}`;
    return variant === 'instruction' ? 'Drop an app here to give it a tool' : t('automations.card.port_tools_none', 'tools');
}

/**
 * The AI step card in its three variants (handoff 5, round 3, artboard 3b):
 * a loose instruction (sparkles, the prompt as summary), an agent (bot tile,
 * "AI step · agent", "<agent> · n skills · n tools") and a skill without an
 * agent (zap tile in the skill colour, "AI step · skill"). The agent and
 * skill variants show what they bring as ports under the card.
 */
export default function AiStepNode({ id, data }) {
    const { t } = useTranslation();
    const { step, runStep, issues, onAddAfter, toolPortActive = false, agentNameById } = data;
    const tier = step.modelTier || 'auto';
    const allowTools = !!step.allowTools;
    const toolCount = Array.isArray(step.tools) ? step.tools.length : 0;
    const toolState = toolStateOf(step);
    const ports = aiStepPortCounts(step);
    const agentName = ports.agentId ? (agentNameById?.[ports.agentId] || null) : null;
    const card = aiStepCardText(step, { t, agentName, typeLabel: nodeTypeLabel('ai_step') });
    const variant = card.variant;
    const Icon = VARIANT_ICON[variant];

    const badges = (
        <>
            <ForEachBadge step={step} />
            <NodeChip tone="accent" title={`Model tier: ${tier}`}>{tier}</NodeChip>
            {allowTools && (
                <NodeChip tone="warn" title={`Can call ${toolCount || 'all permitted'} tool(s)`}>
                    <Hammer size={10} />{toolCount ? toolCount : ''}
                </NodeChip>
            )}
        </>
    );

    return (
        <StepNodeBase
            icon={<Icon size={14} />}
            typeLabel={card.typeLabel}
            help={nodeHelp('ai_step')}
            name={step.label || 'AI step'}
            sub={card.sub}
            subTitle={card.subTitle}
            badges={badges}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
            tileColor={variant === 'skill' ? 'var(--kind-skill)' : null}
            portsRow={variant === 'instruction' ? null : (
                <AiStepPorts
                    agentId={ports.agentId}
                    agentName={agentName}
                    skillIds={ports.skillIds}
                    knowledgeBaseIds={ports.knowledgeBaseIds}
                />
            )}
            // The tools port. An AI step is the one node whose capabilities are
            // configuration rather than flow, so it gets a second output that
            // says so — and accepts an app dragged straight from the ribbon.
            bottomPort={{
                handleId: TOOL_HANDLE_ID,
                label: toolPortLabel(toolState, variant, toolCount, t),
                hint: 'Drag an app from the ribbon onto this port to let the AI use it.',
                active: toolPortActive,
            }}
        />
    );
}
