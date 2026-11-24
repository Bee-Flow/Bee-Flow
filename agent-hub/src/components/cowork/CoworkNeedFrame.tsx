/**
 * The frame every card of ./CoworkNeedCard.tsx shares, and the one way a card acts.
 *
 *   On the home      a row of the "Needs you" list: the task it is about first (a link that opens it), then ONE plain
 *                    sentence, a line under it, what it is about (a message, a fix), and the buttons: one primary
 *                    action that resolves it and a secondary way out.
 *   Inside a task    (`solo`) the same without the task's name, as a flat card of its own with a coloured edge:
 *                    amber for a question, red for a problem.
 *
 * An action runs through `useNeedAct`: the buttons wait while it runs, a refusal is said in the server's own words
 * under them, and afterwards every Cowork read is read again, so the card goes once its need is gone.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { BLOCKS, type NeedCardData } from './coworkNeedsModel';
import { useTranslation } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';

/** Where a card can take the owner in the task: its steps (a plan to check or fix). */
export type TaskFocus = 'steps';

/** What every card of a kind receives. */
export interface NeedKindProps {
    need: NeedCardData;
    solo: boolean;
    onOpenTask: (itemId: string, focus?: TaskFocus) => void;
    /** After the card's action worked: one sentence that says what happened (the page shows it a moment). */
    onDone: (message: string) => void;
}

interface NeedFrameProps {
    need: NeedCardData;
    solo: boolean;
    onOpenTask: (itemId: string, focus?: TaskFocus) => void;
    title: string;
    sub?: string | null;
    /** What it is about, between the sentence and the buttons. */
    extra?: ReactNode;
    actions: ReactNode;
    error?: Error | null;
}

const SOLO_TONE: Readonly<Record<'failed' | 'needs', string>> = {
    failed: 'rounded-[var(--radius-lg)] border border-[var(--border-default)] border-l-2 border-l-[var(--error-ink)] bg-[var(--bg-card)]',
    needs: 'rounded-[var(--radius-lg)] border border-[var(--border-default)] border-l-2 border-l-[var(--warning-ink)] bg-[var(--bg-card)]',
};

const DOT: Readonly<Record<'failed' | 'needs', string>> = {
    failed: 'bg-[var(--error-ink)]',
    needs: 'bg-[var(--warning-ink)]',
};

export function NeedFrame({ need, solo, onOpenTask, title, sub, extra, actions, error }: NeedFrameProps) {
    const { t } = useTranslation();
    const tone = BLOCKS[need.kind];
    return (
        // motion: ENTER (and its leaving, when the card goes)
        <article className={`flex flex-col gap-3 p-4 ${solo ? SOLO_TONE[tone] : ''}`} data-testid="cowork-need-card" data-kind={need.kind}>
            <div className="flex flex-col gap-0.5 min-w-0">
                {!solo && (
                    <button
                        type="button"
                        className="self-start inline-flex items-center gap-1.5 min-h-6 text-[13px] font-semibold text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:underline"
                        onClick={() => onOpenTask(need.itemId)}
                    >
                        <span aria-hidden="true" className={`w-2 h-2 rounded-full flex-shrink-0 ${DOT[tone]}`} />
                        {need.title || t('cowork_home.untitled', 'Untitled task')}
                    </button>
                )}
                <p className="text-[16px] font-semibold text-[var(--text-primary)]">{title}</p>
                {sub && <p className="text-[14px] text-[var(--text-secondary)]">{sub}</p>}
            </div>
            {extra}
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
            {error && <p role="alert" className="text-[13px] text-[var(--error-ink)]">{errorMessage(error) || t('cowork_home.failed', 'That did not work. Try again.')}</p>}
        </article>
    );
}

/** A box for what the card is about: the message that waits, the agent's question. */
export function NeedBox({ children, testId }: { children: ReactNode; testId?: string }) {
    return (
        <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-3 py-3 text-[14px] whitespace-pre-wrap break-words text-[var(--text-secondary)]" data-testid={testId}>
            {children}
        </div>
    );
}

/**
 * The card's action: run it, then read every Cowork query again and say what happened. `settle: false` leaves the
 * reads alone, for a card that has a second question after its action (a message sent: "always allow?").
 */
export function useNeedAct(onDone: (message: string) => void) {
    const client = useQueryClient();
    return useMutation<unknown, Error, { run: () => Promise<unknown>; done?: string; settle?: boolean }>({
        mutationFn: ({ run }) => run(),
        onSuccess: async (_answer, { done, settle = true }) => {
            if (settle) await client.invalidateQueries({ queryKey: ['cowork'] });
            if (done) onDone(done);
        },
    });
}
