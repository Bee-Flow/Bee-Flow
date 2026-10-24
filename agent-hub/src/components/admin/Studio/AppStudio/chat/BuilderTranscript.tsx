/**
 * The builder chat's transcript: messages, screenshots and error items, the
 * plan card, the phase / continuation lines, "What changed" and the waiting
 * card. The model's own checklist (app_set_plan) is NOT here (owner,
 * 2026-09-16): it rides on the canvas, where the build is, instead of
 * scrolling away with the conversation. The shell draws it from the build
 * cue this pane publishes (AppEditorShell).
 */
import { Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import AppBuilderActivity from './AppBuilderActivity';
import PlanCard from './PlanCard';
import { ErrorItem, ScreenshotItem } from './TranscriptItems';
import type { TranscriptImage } from './TranscriptItems';
import WhatChanged from './WhatChanged';
import type { TurnChange } from './WhatChanged';
import type { BuilderMessage } from '../../../../../hooks/builderStream';
import type { BuildPhaseInfo } from '../editor/BuildCueContext';
import useTranslation from '../../../../../hooks/useTranslation';
import MessageBubble from '../../../../automation/Builder/chat/MessageBubble';
import BuilderWaitingCard from '../../../../shared/builder/BuilderWaitingCard';

/** The empty pane's invitation. */
export function TranscriptEmptyState() {
    const { t } = useTranslation();
    return (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <span
                className="flex h-10 w-10 items-center justify-center rounded-full [background:color-mix(in_srgb,var(--accent-primary)_12%,transparent)] [color:var(--accent-primary)]"
            >
                <Sparkles size={18} aria-hidden="true" />
            </span>
            <p className="text-sm font-medium text-[var(--text-primary)]">
                {t('app_studio.builder.chat.empty_title', 'Build with AI')}
            </p>
            <p className="text-xs leading-relaxed text-[var(--text-tertiary)]">
                {t('app_studio.builder.chat.empty_hint', "Describe the app you want — I'll build it on the canvas")}
            </p>
        </div>
    );
}

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
        </>
    );
}
