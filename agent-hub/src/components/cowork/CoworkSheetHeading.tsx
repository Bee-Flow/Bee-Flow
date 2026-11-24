/**
 * The heading every panel of the Cowork sheet (./coworkSheetPanels.ts) starts with, and an optional line under it.
 */
import type { ReactNode } from 'react';

export default function CoworkSheetHeading({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5 pb-5">
            <h2 className="text-[26px] leading-tight font-semibold tracking-[-0.015em] text-[var(--text-primary)]">{children}</h2>
            {sub && <p className="text-[14px] text-[var(--text-tertiary)]">{sub}</p>}
        </div>
    );
}
