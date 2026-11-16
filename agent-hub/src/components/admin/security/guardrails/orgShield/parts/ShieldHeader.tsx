import { ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';

import { DetectionStatusPill } from './DetectionStatusPill';
import type { GuardStatus } from './DetectionStatusPill';
import type { TranslateFn } from '@/hooks/useTranslation';
import { SHIELD_ROW } from '../shieldLayout';

/**
 * The Privacy Shield's header block: whose shield it is (the page title is the
 * admin dashboard's), the one
 * fact that decides whether anything below it matters, and the path strip.
 *
 * ── Why the guard pill lives up here ──────────────────────────────────────
 * Detection is platform-level and was previously only visible on a
 * platform-admin console an org admin cannot open. Up here it is stated on
 * every pane (see DetectionStatusPill).
 *
 * ── Why the strip is a slot ───────────────────────────────────────────────
 * Title row and strip are one surface with one bottom border, so the strip
 * renders INSIDE this block. It is a slot rather than built in because it
 * only exists once a document has loaded; the error and empty states keep
 * the title row alone.
 */
export function ShieldHeader({
    orgName, guard, guardCheckedAt = null, strip = null, t, children,
}: {
    orgName?: string | null;
    guard: GuardStatus | null;
    guardCheckedAt?: number | null;
    strip?: ReactNode;
    t: TranslateFn;
    children?: ReactNode;
}) {
    return (
        <div className="shrink-0 bg-[var(--bg-card)] border-b border-[var(--border-default)]">
            {/* 30px controls + 12px either side = the 54px row; it only grows
                when a narrow window wraps it. */}
            <div className={`flex items-center flex-wrap gap-x-2.5 gap-y-2 min-h-[54px] py-3 [@media(max-height:780px)]:min-h-[46px] [@media(max-height:780px)]:py-2 px-6 ${SHIELD_ROW}`}>
                <div className="w-7 h-7 rounded-lg grid place-items-center shrink-0 bg-[color-mix(in_srgb,var(--error)_14%,transparent)] text-[var(--error)]">
                    <ShieldCheck className="w-[15px] h-[15px]" aria-hidden="true" />
                </div>
                {/* The admin dashboard's page header already says "Privacy Shield":
                    this row names whose shield it is, not the page again. */}
                {orgName && (
                    <span className="text-[13px] font-semibold min-w-0 truncate text-[var(--text-primary)]" data-testid="shield-org-name">{orgName}</span>
                )}

                <div className="flex-1" />

                <DetectionStatusPill guard={guard} checkedAt={guardCheckedAt} t={t} />
                {children}
            </div>
            {strip}
        </div>
    );
}

export default ShieldHeader;
