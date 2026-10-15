// Types for the JavaScript status pill, so TypeScript callers see its real
// props (the .jsx infers every destructured prop without a default as required).
import type { LucideIcon } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

export type StatusPillTone = 'neutral' | 'success' | 'warning' | 'error' | 'muted';

export interface StatusPillProps {
    tone?: StatusPillTone;
    icon?: LucideIcon | null;
    children?: ReactNode;
    className?: string;
    testId?: string;
    title?: string;
}

export default function StatusPill(props: StatusPillProps): ReactElement;
