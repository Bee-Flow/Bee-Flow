/**
 * The builder chat's transcript: messages, screenshots and error items, the
 * plan card, the phase / continuation lines, "What changed" and the waiting
 * card. The model's own checklist (app_set_plan) is NOT here (owner,
 * 2026-09-16): it rides on the canvas, where the build is, instead of
 * scrolling away with the conversation. The shell draws it from the build
 * cue this pane publishes (AppEditorShell).
 */
import type { ReactNode } from 'react';
import AppBuilderActivity from './AppBuilderActivity';
import PlanCard from './PlanCard';
import { ErrorItem, ScreenshotItem } from './TranscriptItems';
import type { TranscriptImage } from './TranscriptItems';
import WhatChanged from './WhatChanged';
import type { TurnChange } from './WhatChanged';
import type { BuilderMessage } from '@/hooks/builderStream';
import type { BuildPhaseInfo } from '../editor/BuildCueContext';
import useTranslation from '@/hooks/useTranslation';
import MessageBubble from '@/components/automation/Builder/chat/MessageBubble';
import QuestionsCard from '@/components/automation/Builder/chat/QuestionsCard';
import type { BuilderQuestion } from '@/components/automation/Builder/chat/QuestionsCard';
import BuilderWaitingCard from '@/components/shared/builder/BuilderWaitingCard';

interface BuilderTranscriptProps {
    messages: BuilderMessage[];
    running: boolean;
    busy: boolean;
    pendingPlan: unknown;
    currentPhase: BuildPhaseInfo | null;
    continuation: { phase: unknown; total: number | null } | null;
    lastChange: TurnChange | null;
    changeOpen: boolean;
    onToggleChange: () => void;
    onSelectChanged: (nodeId: string) => void;
    onUndoTurn: (() => void) | null;
    onRevert: (() => void) | null;
    onRetry: () => void;
    onApprovePlan: (plan: unknown) => void;
    onDiscussPlan: () => void;
    waitingForFirstToken: boolean;
    /** The questions the builder asked before planning; the shared card answers them. */
    reviewQuestions: BuilderQuestion[] | null;
    onAnswerQuestions: (text: string) => void;
}

function TranscriptItem({ item, isLatest, running, busy, onRetry }: { item: BuilderMessage; isLatest: boolean; running: boolean; busy: boolean; onRetry: () => void }): ReactNode {
    const { t } = useTranslation();
    if (item?.kind === 'image') return <ScreenshotItem item={item as TranscriptImage} />;
    if (item?.kind === 'error') {
        // Only the newest error item gets the retry button — retrying re-runs
        // the LAST turn, so an old item offering it would be misleading.
        return (
            <ErrorItem
                message={item.message as string | undefined}
                code={item.code as string | null | undefined}
                onRetry={isLatest ? onRetry : null}
                disabled={busy}
            />
        );
    }
    return (
        <MessageBubble
            msg={item}
            activity={item.role === 'assistant'
                ? <AppBuilderActivity toolCalls={item.toolCalls} running={!!item.isStreaming && running} t={t} />
                : null}
        />
    );
}

export default function BuilderTranscript({
    messages, running, busy, pendingPlan, currentPhase, continuation, lastChange, changeOpen, onToggleChange,
    onSelectChanged, onUndoTurn, onRevert, onRetry, onApprovePlan, onDiscussPlan, waitingForFirstToken,
    reviewQuestions, onAnswerQuestions,
}: BuilderTranscriptProps) {
    const { t } = useTranslation();
    return (
        <>
            {messages.map((item, i) => (
                <TranscriptItem key={i} item={item} isLatest={i === messages.length - 1} running={running} busy={busy} onRetry={onRetry} />
            ))}

            {/* The AI proposed an editable plan — approve or discuss it. */}
            {pendingPlan ? (
                <PlanCard
                    pendingPlan={pendingPlan}
                    onBuild={onApprovePlan}
                    onDiscuss={onDiscussPlan}
                    disabled={busy}
                />
            ) : null}

            {/* Phased-build progress. */}
            {running && currentPhase ? (
                <div className="self-start px-1 text-xs font-medium text-[var(--accent-primary)]">
                    {t('app_studio.builder.chat.phase_line', 'Building — phase {i}{total}{label}', { i: currentPhase.index, total: currentPhase.total ? `/${currentPhase.total}` : '', label: currentPhase.label ? `: ${currentPhase.label}` : '' })}
                </div>
            ) : null}

            {/* Auto-continuation after a mid-plan budget exhaustion. */}
            {continuation ? (
                <div className="self-start px-1 text-xs italic text-[var(--text-tertiary)]">
                    {t('app_studio.builder.chat.continuing', 'Continuing{phase}…', { phase: continuation.phase ? ` (phase ${continuation.phase}${continuation.total ? `/${continuation.total}` : ''})` : '' })}
                </div>
            ) : null}

            {/* Post-turn "What changed" summary. */}
            {lastChange && !running ? (
                <WhatChanged
                    change={lastChange}
                    open={changeOpen}
                    onToggle={onToggleChange}
                    onSelect={onSelectChanged}
                    onUndo={onUndoTurn}
                    onRevert={onRevert}
                />
            ) : null}

            {waitingForFirstToken && (
                <BuilderWaitingCard />
            )}

            {/* The builder's questions, not while a plan card waits for its OK. */}
            {reviewQuestions?.length && !pendingPlan ? (
                <QuestionsCard
                    key={reviewQuestions[0].id}
                    questions={reviewQuestions}
                    // The card can arrive while the turn is still closing:
                    // greyed out until it has, so an answer is never dropped.
                    running={busy}
                    onAnswer={(text) => onAnswerQuestions(text)}
                />
            ) : null}
        </>
    );
}
