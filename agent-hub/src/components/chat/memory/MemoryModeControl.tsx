import { Ban, BookOpen, Brain } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import { nextMemoryMode, type MemoryLock, type MemoryMode } from '../../../utils/memoryMode';
import { memoryHint, memoryStateLabel } from './memoryModeCopy';

const ICONS = { on: Brain, read: BookOpen, off: Ban } as const;

export interface MemoryModeControlProps {
    mode: MemoryMode;
    onChange: (next: MemoryMode) => void;
    /** Set when the person or the organisation switched memory off elsewhere. */
    lock?: MemoryLock;
    testId?: string;
    className?: string;
}

/**
 * The three-state memory control of the composer: each click moves on to the
 * next state (On, Read only, Off for this chat). When memory is paused or off for
 * the organisation the control stays visible but locked, and its tooltip says
 * where to change it. It is `aria-disabled`, not `disabled`, so it keeps focus
 * and the tooltip stays reachable by keyboard.
 */
export default function MemoryModeControl({ mode, onChange, lock = null, testId = 'memory-mode-control', className = '' }: MemoryModeControlProps) {
    const { t } = useTranslation();
    const shown: MemoryMode = lock ? 'off' : mode;
    const Icon = ICONS[shown];
    const hint = memoryHint(t, mode, lock);
    const active = !lock && mode === 'on';
    return (
        <button
            type="button"
            onClick={() => { if (!lock) onChange(nextMemoryMode(mode)); }}
            aria-pressed={active}
            aria-disabled={lock ? true : undefined}
            aria-label={`${t('chat.memory.control_label', 'Memory')}: ${lock ? hint : memoryStateLabel(t, mode)}`}
            title={hint}
            data-testid={testId}
            data-memory-mode={shown}
            data-memory-lock={lock ?? undefined}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-full p-0 transition-colors motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)] ${
                active
                    ? 'cursor-pointer bg-[color-mix(in_srgb,var(--accent-primary)_14%,transparent)] text-[var(--accent-primary)]'
                    : 'bg-transparent text-[var(--text-tertiary)] opacity-60'
            } ${lock ? 'cursor-not-allowed' : mode === 'read' ? 'cursor-pointer opacity-90' : 'cursor-pointer'} ${className}`}
        >
            <Icon className="h-4 w-4" aria-hidden="true" />
        </button>
    );
}
