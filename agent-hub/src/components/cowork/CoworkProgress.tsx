/**
 * A visible progress in a few named phases: what is done (a tick), what happens now (a spinner) and what comes. The
 * home shows it while Cowork sets up and tests a new task's steps (./CoworkHomeComposer.tsx); a card or the opened
 * task shows the same for a fix or a run. Announced politely. A phase that ticks over fades into its new mark (SWAP of
 * ./coworkMotion.ts); the spinner is the one thing that keeps moving, and it stands still under reduced motion.
 */
import { Check } from 'lucide-react';
import { SPIN, SWAP } from './coworkMotion';

interface CoworkProgressProps {
    labels: readonly string[];
    /** The phase now (0-based); `labels.length` when every phase is done. */
    phase: number;
    testId?: string;
}

type PhaseState = 'did' | 'now' | 'next';

const TEXT: Readonly<Record<PhaseState, string>> = {
    did: 'text-[var(--success-ink)]',
    now: 'font-semibold text-[var(--text-primary)]',
    next: 'text-[var(--text-tertiary)]',
};

const MARK: Readonly<Record<PhaseState, string>> = {
    did: 'border-[var(--success-ink)] text-[var(--success-ink)]',
    now: `border-[var(--text-primary)] border-t-transparent ${SPIN}`,
    next: 'border-[var(--border-default)]',
};

const stateOf = (i: number, phase: number): PhaseState => {
    if (i < phase) return 'did';
    return i === phase ? 'now' : 'next';
};

export default function CoworkProgress({ labels, phase, testId = 'cowork-progress' }: CoworkProgressProps) {
    return (
        <ol className="m-0 flex list-none flex-col gap-2 p-0" role="status" aria-live="polite" data-testid={testId}>
            {labels.map((label, i) => {
                const state = stateOf(i, phase);
                return (
                    <li key={label} data-state={state} className={`flex items-center gap-2 text-[14px] leading-5 ${TEXT[state]}`}>
                        {/* The spinner turns on its own box, with no text in it; the label beside it never moves. */}
                        <span key={state} aria-hidden="true" className={`grid place-items-center w-5 h-5 rounded-full border-2 flex-shrink-0 ${MARK[state]} ${state === 'now' ? '' : SWAP}`}>
                            {state === 'did' && <Check size={12} strokeWidth={3} />}
                        </span>
                        <span>{label}</span>
                    </li>
                );
            })}
        </ol>
    );
}
