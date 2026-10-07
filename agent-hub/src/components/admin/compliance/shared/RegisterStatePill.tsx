import React from 'react';
import { Check } from 'lucide-react';
import { REGISTER_STATE_CLASS, toneOfRegisterState } from './statusVocabulary';

/**
 * RegisterStatePill: a register record's lifecycle state, drawn the same way
 * on every register (statusVocabulary: neutral · warning · success · muted).
 *
 * The StatusPill recipe (11px semibold, a solid 1px hairline, ink text, no
 * fill) with two additions: a done state leads with a Check glyph, so
 * "Closed" and "Open" differ by more than colour, and a muted state
 * (rejected, dropped, excluded) reads quieter than an open one. The words
 * are the register's own labels (`children`); this atom only decides the
 * look from `state`.
 */
export interface RegisterStatePillProps {
    /** The lifecycle state as stored ('open', 'in_progress', 'fulfilled' ...). */
    state: string | null | undefined;
    /** The register's label for that state. */
    children?: React.ReactNode;
    title?: string;
    className?: string;
    testId?: string;
}

export default function RegisterStatePill({
    state,
    children = null,
    title = undefined,
    className = '',
    testId = 'register-state-pill',
}: RegisterStatePillProps) {
    const tone = toneOfRegisterState(state);
    return (
        <span
            data-testid={testId}
            data-state={state ?? undefined}
            data-tone={tone}
            title={title}
            className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-[3px] rounded-full whitespace-nowrap border border-solid ${REGISTER_STATE_CLASS[tone]} ${className}`.trim()}
        >
            {tone === 'success' && <Check size={11} strokeWidth={2.5} aria-hidden="true" className="flex-shrink-0" />}
            {children}
        </span>
    );
}
