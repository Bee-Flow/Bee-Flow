/**
 * A visible progress in a few named phases: what is done (a tick), what happens now (a spinner) and what comes. The
 * home shows it while Cowork sets up and tests a new task's steps (./CoworkHomeComposer.tsx); a card or the opened
 * task shows the same for a fix or a run. Announced politely; the spinner stands still under reduced motion.
 */
import { Check } from 'lucide-react';

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

const stateOf = (i: number, phase: number): PhaseState => {
    if (i < phase) return 'did';
    return i === phase ? 'now' : 'next';
};

function dotClass(state: PhaseState): string {
    if (state === 'did') return 'border-[var(--success-ink)] text-[var(--success-ink)]';
    if (state === 'now') return 'border-[var(--text-primary)] border-t-transparent motion-safe:animate-spin';
    return 'border-[var(--border-default)]';
}

export default function CoworkProgress({ labels, phase, testId = 'cowork-progress' }: CoworkProgressProps) {
    return (
        <ol className="flex flex-col gap-2.5" role="status" aria-live="polite" data-testid={testId}>
            {labels.map((label, i) => {
                const state = stateOf(i, phase);
                return (
                    <li
                        key={label}
                        data-state={state}
                        className={`flex items-center gap-2.5 text-[14px] ${TEXT[state]}`}
                    >
                        <span aria-hidden="true" className={`grid place-items-center w-[18px] h-[18px] rounded-full border-2 flex-shrink-0 ${dotClass(state)}`}>
                            {state === 'did' && <Check className="w-2.5 h-2.5" strokeWidth={3} />}
                        </span>
                        <span>{label}</span>
                    </li>
                );
            })}
        </ol>
    );
}
