import type { ReactNode } from 'react';
import { DeltaPill, type DeltaProps } from './DeltaPill';
import { MoreLink } from './MoreLink';

export interface KpiTileProps {
    label: string;
    value: ReactNode;
    delta?: DeltaProps;
    /** Mirrors the page-wide compare switch; the delta is hidden when off. */
    compare?: boolean;
    secondary: ReactNode;
    more?: { label: string; onClick: () => void };
    /** A sparkline or segment bar slot. */
    children?: ReactNode;
}

export function KpiTile({ label, value, delta, compare = true, secondary, more, children }: KpiTileProps) {
    return (
        <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-muted)]">{label}</div>
            <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-[32px] font-semibold leading-none text-[var(--text-primary)]">{value}</span>
                {delta && <DeltaPill {...delta} compare={compare} />}
            </div>
            {children}
            <div className="text-[13px] text-[var(--text-secondary)]">{secondary}</div>
            {more && <MoreLink label={more.label} onClick={more.onClick} />}
        </div>
    );
}
