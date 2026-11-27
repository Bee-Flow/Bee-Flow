/**
 * The frame every card of ./CoworkNeedCard.tsx shares, and the one way a card acts.
 *
 *   On the home      a row of the "Needs you" list: the task it is about first (a link that opens it), then ONE plain
 *                    sentence, a line under it, what it is about (a message, a fix), and the buttons: one primary
 *                    action that resolves it and a secondary way out.
 *   Inside a task    (`solo`) the same without the task's name, as a flat card of its own with a coloured edge:
 *                    amber for a question, red for a problem.
 *
 * A card fades in when it arrives. One that puts itself aside (`open` false) fades out before it is gone; one whose
 * need is answered goes with the list it was in.
 *
 * An action runs through `useNeedAct`: the buttons wait while it runs, a refusal is said in the server's own words
 * under them, and afterwards every Cowork read is read again, so the card goes once its need is gone.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { ENTER, LEAVE, TINT, useLeave } from './coworkMotion';
import { BLOCKS, type NeedCardData } from './coworkNeedsModel';
import { ALERT, CARD_INSET, META } from './coworkUi';
import { FOCUS_RING } from '../shared/buttonClasses';
import { useTranslation } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';

/** Where a card can take the owner in the task: its steps (a plan to check or fix). */
export type TaskFocus = 'steps' | 'review';
export const NeedsOverview = createContext(false);

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
    /** False once the card put itself aside ("Not now"): it fades out, then it is gone. */
    open?: boolean;
}

const SOLO_TONE: Readonly<Record<'failed' | 'needs', string>> = {
    failed: 'rounded-[var(--radius-lg)] border border-[color-mix(in_srgb,var(--error)_45%,var(--border-default))] bg-[var(--bg-card)]',
    needs: 'rounded-[var(--radius-lg)] border border-[color-mix(in_srgb,var(--warning)_55%,var(--border-default))] bg-[var(--bg-card)]',
};

const DOT: Readonly<Record<'failed' | 'needs', string>> = {
    failed: 'bg-[var(--error-ink)]',
    needs: 'bg-[var(--warning-ink)]',
};

export function NeedFrame({ need, solo, onOpenTask, title, sub, extra, actions, error, open = true }: NeedFrameProps) {
    const { t } = useTranslation();
    const tone = BLOCKS[need.kind];
    const { ref, mounted, leaving } = useLeave<HTMLElement>(open);
    const overview = useContext(NeedsOverview);
    if (!mounted) return null;
    if (overview) return <button type="button" className="flex w-full flex-col items-start gap-1 px-4 py-3 text-left hover:bg-[var(--bg-secondary)]"
        data-testid="cowork-need-card" data-kind={need.kind} onClick={() => onOpenTask(need.itemId, 'review')}>
        <strong>{need.title || t('cowork_home.untitled', 'Untitled task')}</strong><span className={META}>{title}</span>
    </button>;
    return (
        <article ref={ref} className={`flex flex-col gap-3 p-4 ${leaving ? LEAVE : ENTER} ${solo ? SOLO_TONE[tone] : ''}`} data-testid="cowork-need-card" data-kind={need.kind}>
            <div className="flex flex-col gap-0.5 min-w-0">
                {!solo && (
                    <button
                        type="button"
                        className={`self-start inline-flex items-center gap-1.5 -my-1.5 min-h-9 pointer-coarse:-my-2.5 pointer-coarse:min-h-11! rounded-lg text-[13px] leading-5 font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline ${TINT} ${FOCUS_RING}`}
                        onClick={() => onOpenTask(need.itemId)}
                    >
                        <span aria-hidden="true" className={`w-2 h-2 rounded-full flex-shrink-0 ${DOT[tone]}`} />
                        {need.title || t('cowork_home.untitled', 'Untitled task')}
                    </button>
                )}
                <p className="m-0 text-[14px] leading-5 font-semibold text-[var(--text-primary)]">{title}</p>
                {sub && <p className={`m-0 ${META}`}>{sub}</p>}
            </div>
            {extra}
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
            {error && <p role="alert" className={ALERT}>{errorMessage(error) || t('cowork_home.failed', 'That did not work. Try again.')}</p>}
        </article>
    );
}

/** A box for what the card is about: the message that waits, the agent's question. */
export function NeedBox({ children, testId }: { children: ReactNode; testId?: string }) {
    return (
        <div className={`${CARD_INSET} px-3 py-3 text-[14px] leading-5 whitespace-pre-wrap break-words text-[var(--text-secondary)]`} data-testid={testId}>
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
