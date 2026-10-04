/**
 * What the assistant sheet says about a turn while it streams, and about the
 * conversation around it. Pure, over the builder stream's turn
 * (api/builderStream.ts) and the persisted session (api/builder.ts):
 *
 *   - the one-line status: reading, typing a tool call, a flowlet being built
 *     by a delegated agent, the narrator's gloss of the reasoning;
 *   - the activity rows of the turn so far, with a live "Testing the
 *     automation…" row at the foot while its dry run goes (the web's
 *     BuilderActivity liveRun row);
 *   - the plan checklist: the turn's, else the session's last one;
 *   - what happened to the draft: how many drafts arrived, and the findings.
 */

import type { BuilderMessage, BuilderSnapshot, BuilderTodo, BuilderTurn, IssueSet } from '@/features/flow-editor/api';
import { humanizeToolName, type Translate } from '@/features/flow-editor/model';

import { describeLiveRun, describeToolCall, type ActivityRow, type AppLabel } from './activity';

/** "Building: add steps · 3" while the model types a tool call. */
function buildingStatus(turn: BuilderTurn, t: Translate): string {
    const tool = turn.toolDraft?.name ? humanizeToolName(turn.toolDraft.name.replace(/^builder_(add_)?/, '')) : null;
    const count = turn.toolDraft?.count ?? 0;
    if (tool && count > 0) return t('mobile.flow.ai.building_n', 'Building: {tool} · {n}', { tool, n: count });
    return tool ? t('mobile.flow.ai.building_tool', 'Building: {tool}', { tool }) : t('automations.builder.act.building', 'Building');
}

export function turnStatus(turn: BuilderTurn, t: Translate): string | null {
    if (turn.done) return null;
    if (turn.layerAgent) return t('mobile.flow.ai.building_layer', 'Building the flowlet “{name}”…', { name: turn.layerAgent });
    if (turn.phase === 'building') return buildingStatus(turn, t);
    if (turn.thinkingSummary?.text) return turn.thinkingSummary.text;
    if (turn.phase === 'reading') return t('mobile.flow.ai.reading', 'Reading the automation…');
    if (turn.thinkingActive) return t('automations.builder.thinking', 'Thinking…');
    return turn.text ? null : t('mobile.flow.ai.working', 'Working…');
}

export function turnActivity(turn: BuilderTurn, t: Translate, appLabel?: AppLabel): ActivityRow[] {
    const rows = turn.toolCalls.map((c) => describeToolCall(c, t, appLabel));
    if (!turn.done && turn.dryRun?.running) rows.push(describeLiveRun(null, t));
    return rows;
}

export function messageActivity(message: BuilderMessage, t: Translate, appLabel?: AppLabel): ActivityRow[] {
    return message.role === 'assistant' ? message.toolCalls.map((c) => describeToolCall(c, t, appLabel)) : [];
}

/** The live turn's checklist, else the last one the session kept. */
export function planOf(live: readonly BuilderTodo[], snapshot: BuilderSnapshot | null | undefined): readonly BuilderTodo[] {
    if (live.length) return live;
    return snapshot?.todos ?? [];
}

export interface TurnOutcome {
    /** The AI replaced the definition this many times (one undo takes all of it back). */
    drafts: number;
    errors: number;
    warnings: number;
}

export function turnOutcome(turn: BuilderTurn): TurnOutcome {
    const v: IssueSet | null = turn.validation;
    return { drafts: turn.draftCount, errors: v?.errors.length ?? 0, warnings: v?.warnings.length ?? 0 };
}

/** The words for a turn that ended in an error, or stopped on its round budget. */
export function turnProblem(turn: BuilderTurn, t: Translate): { text: string; retry: boolean } | null {
    if (turn.error) {
        return turn.transient
            ? { text: t('mobile.flow.ai.transient', '{error} Your automation is safe — send the message again.', { error: turn.error }), retry: true }
            : { text: turn.error, retry: false };
    }
    if (turn.aborted) {
        return { text: t('mobile.flow.ai.aborted', 'The assistant stopped before it finished ({reason}). Ask it to continue.', { reason: turn.aborted.reason || '—' }), retry: true };
    }
    return null;
}
