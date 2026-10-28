import React from 'react';
import { Plus, Play, Pin, PinOff, Loader2, Copy as CopyIcon, Trash2, Unlink } from 'lucide-react';
import type { ChromeBadge } from '../nodeTypeColors';
import { humanizeIssueText } from '../displayHelpers';
import useTranslation from '@/hooks/useTranslation';
import type { NodeRuntime, StepIssue, StepIssues } from './StepNodeBase.types';

const ACTION_BTN = 'h-6 w-6 rounded-md flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30 disabled:cursor-not-allowed';

type ClickEvent = React.MouseEvent<HTMLButtonElement>;
const stopDown = (e: ClickEvent) => e.stopPropagation();

export interface StepActionToolbarProps {
    nodeId: string | null;
    rt: NodeRuntime;
    chromeVisibility: string;
    pinned: boolean | undefined;
    runInFlight: boolean;
    executingThis: boolean;
    showDuplicate: boolean;
    showDetach: boolean;
    showPin: boolean;
    showDelete: boolean;
}

/**
 * Action chrome — ONE centred row 8px above the card, five actions in a fixed
 * order so it never jumps from node to node (BFSF-346). R / D / U / P / Del do
 * the same on the selected card.
 */
export function StepActionToolbar({
    nodeId, rt, chromeVisibility, pinned, runInFlight, executingThis, showDuplicate, showDetach, showPin, showDelete,
}: StepActionToolbarProps) {
    const { t } = useTranslation();
    const onExecuteStep = rt.onExecuteStep;
    if (!((onExecuteStep || showDuplicate || showDetach || showPin || showDelete) && nodeId)) return null;
    return (
        <div
            className={`absolute left-1/2 -translate-x-1/2 flex items-center gap-0.5 px-1 py-0.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border-default)] shadow-sm z-[2] ${chromeVisibility} [top:-30px]`}
            data-testid="node-hover-toolbar"
        >
            {onExecuteStep && (
                <button
                    type="button"
                    onClick={(e: ClickEvent) => { e.stopPropagation(); onExecuteStep(nodeId, { mode: 'upTo' }); }}
                    onMouseDown={stopDown}
                    disabled={runInFlight || executingThis}
                    title={runInFlight ? 'Run in progress' : 'Run the flow up to here (pinned steps reuse their data) — R'}
                    className={ACTION_BTN}
                    aria-label={t('automations.step_node_base.execute_step', 'Execute step')}
                >
                    {executingThis ? <Loader2 size={12} className="animate-spin" /> : <Play size={11} fill="currentColor" />}
                </button>
            )}
            {showDuplicate && (
                <button
                    type="button"
                    onClick={(e: ClickEvent) => { e.stopPropagation(); (rt.onDuplicateNode as (stepId: string) => void)(nodeId); }}
                    onMouseDown={stopDown}
                    title={t('automations.step_node_base.duplicate_this_step_d', 'Duplicate this step — D')}
                    aria-label={t('automations.step_node_base.duplicate_step', 'Duplicate step')}
                    className={ACTION_BTN}
                >
                    <CopyIcon size={11} />
                </button>
            )}
            {showDetach && (
                <button
                    type="button"
                    onClick={(e: ClickEvent) => { e.stopPropagation(); (rt.onDetachNode as (stepId: string) => void)(nodeId); }}
                    onMouseDown={stopDown}
                    title={t('automations.step_node_base.take_this_step_out_of_the', 'Take this step out of the flow (it stays on the canvas, its neighbours reconnect) — U')}
                    aria-label={t('automations.step_node_base.disconnect_step', 'Disconnect step')}
                    className={ACTION_BTN}
                >
                    <Unlink size={11} />
                </button>
            )}
            {showPin && (
                <button
                    type="button"
                    onClick={(e: ClickEvent) => { e.stopPropagation(); (rt.onPinNode as (stepId: string) => void)(nodeId); }}
                    onMouseDown={stopDown}
                    title={pinned ? 'Release the frozen output — P' : 'Freeze the last output so later runs reuse it — P'}
                    aria-label={pinned ? 'Unpin step' : 'Pin step'}
                    className={ACTION_BTN}
                    style={pinned ? { color: 'var(--pinned)' } : undefined}
                >
                    {pinned ? <PinOff size={11} /> : <Pin size={11} />}
                </button>
            )}
            {showDelete && (
                <button
                    type="button"
                    onClick={(e: ClickEvent) => { e.stopPropagation(); (rt.onDeleteNode as (stepId: string) => void)(nodeId); }}
                    onMouseDown={stopDown}
                    title={t('automations.step_node_base.delete_this_step_reconnects_its_neighbours', 'Delete this step (reconnects its neighbours) — Del')}
                    aria-label={t('automations.step_node_base.delete_step', 'Delete step')}
                    className={`${ACTION_BTN} hover:!text-[var(--error)]`}
                >
                    <Trash2 size={11} />
                </button>
            )}
        </div>
    );
}

/**
 * Quick-add "+" — past the right handle, filled in the theme ink. The caller
 * suppresses it on branch nodes, where "add after" is ambiguous.
 */
export function AddAfterButton({ nodeId, onAddAfter, chromeVisibility }: { nodeId: string; onAddAfter: (nodeId: string) => void; chromeVisibility: string }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            onClick={(e: ClickEvent) => { e.stopPropagation(); onAddAfter(nodeId); }}
            onMouseDown={stopDown}
            className={`absolute top-1/2 -translate-y-1/2 -right-7 h-[22px] w-[22px] rounded-full flex items-center justify-center shadow-sm ${chromeVisibility} [background:var(--text-primary)] [color:var(--bg-primary)]`}
            title={t('automations.step_node_base.add_next_step', 'Add next step')}
            aria-label={t('automations.step_node_base.add_next_step', 'Add next step')}
        >
            <Plus size={13} />
        </button>
    );
}

/**
 * ONE badge slot: the run status wins; otherwise the type's own. Only up close
 * — further out the border and ring already say it. In the top-right CORNER,
 * over the border, so the name row keeps its full width.
 */
export function BadgeSlot({ badgeText, badge, badges }: { badgeText: string | null; badge: ChromeBadge | null; badges: React.ReactNode }) {
    return (
        <div className="absolute flex items-center gap-1 max-w-[96px] overflow-hidden [top:-9px] [right:10px]" data-testid="node-badge-slot">
            {badgeText ? (
                <span
                    className="text-[10px] font-bold leading-4 px-1.5 rounded-md whitespace-nowrap"
                    style={{ background: (badge as ChromeBadge).bg, color: (badge as ChromeBadge).fg }}
                    data-testid="node-status-badge"
                >
                    {badgeText}
                </span>
            ) : badges}
        </div>
    );
}

/**
 * Validation dot — 12px, outside the bottom-right corner. Two tones on
 * purpose: a warning-only node must not read as broken. The card itself stays
 * neutral; the message lives in the tooltip and in the step editor.
 */
export function ValidationDot({ issues, errCount, stepLabelById }: { issues: StepIssues | undefined; errCount: number; stepLabelById: Map<string, string> | null | undefined }) {
    return (
        <span
            className="absolute rounded-full border-2 border-[var(--bg-primary)]"
            style={{ right: -5, bottom: -5, width: 12, height: 12, background: errCount > 0 ? 'var(--error)' : 'var(--warning)' }}
            data-testid="node-validation-dot"
            data-tone={errCount > 0 ? 'error' : 'warning'}
            title={validationDotTitle(issues, stepLabelById)}
        />
    );
}

/**
 * What the validation dot says on hover. Two rules, both paid for:
 *
 * The SENTENCE comes first, and it says the names the author gave their steps.
 * The tooltip used to open with the server's validation code
 * (`ai_step.agent_unavailable: …`) — the one token in the line that explains
 * nothing to the person reading it — and the message behind it still carried
 * raw step ids (`Step code_a3f91b: …`) while the canvas pill, one pane away,
 * had already swapped those for labels (FloatingValidationPill →
 * humanizeIssueText). The same failure spoke two languages depending on where
 * you read it, so the author who clicked a pill BECAUSE it named their step
 * landed on a card talking about a hex id and reasonably concluded there were
 * two problems. Same helper on both surfaces now, so they cannot drift again.
 *
 * The CODE stays — demoted to the tail, in parentheses. It is what support
 * asks for, and this tooltip is the only place on the card with room for it;
 * deleting it would cap the power user to serve the beginner.
 */
function validationDotTitle(issues: StepIssues | undefined, stepLabelById: Map<string, string> | null | undefined): string {
    return [...(issues?.errors || []), ...(issues?.warnings || [])]
        .map((r: StepIssue) => {
            const sentence = humanizeIssueText(r.message, stepLabelById) || r.message || '';
            return r.code ? `${sentence} (${r.code})` : sentence;
        })
        .join('\n');
}
