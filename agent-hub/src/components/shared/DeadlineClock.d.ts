// Types for the deadline clock (DeadlineClock.jsx).
import type { ReactElement } from 'react';

export interface DeadlineClockProps {
    variant?: 'rail' | 'row' | 'card' | string;
    dueAt?: string | null;
    startedAt?: string | null;
    doneAt?: string | null;
    state?: string;
    pct?: number | null;
    urgentBelowMs?: number;
    now?: number;
    className?: string;
    testId?: string;
}

export function useNow(intervalMs?: number): number;
export default function DeadlineClock(props: DeadlineClockProps): ReactElement;
