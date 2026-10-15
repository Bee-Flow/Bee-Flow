// Types for the JavaScript score ring, so TypeScript callers see its real
// props (the .jsx infers every destructured prop without a default as required).
import type { ReactElement } from 'react';

export interface ScoreRingProps {
    score: number | null | undefined;
    size?: number;
    tone?: 'success' | 'warning' | 'error' | 'neutral';
    placeholder?: boolean;
    label?: string;
    className?: string;
    testId?: string;
}

export default function ScoreRing(props: ScoreRingProps): ReactElement;
