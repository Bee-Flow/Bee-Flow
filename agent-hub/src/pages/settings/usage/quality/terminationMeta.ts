import { AlertOctagon, RefreshCcw, XCircle, ZapOff, AlertTriangle, type LucideIcon } from 'lucide-react';

export interface TypeMeta {
    /** A theme colour; the same slot in the hero bar, the timeline and the badges. */
    color: string;
    icon: LucideIcon;
}

const META: Record<string, TypeMeta> = {
    max_tokens: { color: 'var(--text-primary)', icon: ZapOff },
    max_iterations: { color: 'var(--text-muted)', icon: RefreshCcw },
    error: { color: 'var(--warning)', icon: AlertOctagon },
    aborted: { color: 'var(--border-default)', icon: XCircle },
};

export const typeMeta = (type: string): TypeMeta => META[type] ?? { color: 'var(--warning)', icon: AlertTriangle };
