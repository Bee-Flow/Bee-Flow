// Types for the navigation count badge (NavCountBadge.jsx).
import type { ReactElement } from 'react';

export function badgeCount(count: unknown): string | null;

export interface NavCountBadgeProps {
    count: number | null | undefined;
    tone?: string;
    max?: number;
    className?: string;
    testId?: string;
}

export default function NavCountBadge(props: NavCountBadgeProps): ReactElement | null;
