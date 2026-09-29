import { PlugZap } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { MS_PER_MINUTE } from '../../../../../../constants/units';
import useRelativeTime from '../../../../../../hooks/useRelativeTime';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';

export interface GuardStatus { configured?: boolean; reachable?: boolean }

/**
 * The header's one line on the detection service, in three states.
 *
 * If the service is not installed or not answering, category detection does
 * not run — so on this screen every category tick, every sensitivity preset
 * and both tool lists are decoration (custom terms and patterns keep working;
 * they need no model). A pill in the header states that on every pane.
 *
 * `guard` null means "not heard back yet" and renders NOTHING: a screen that
 * has not heard from the probe must not claim either health or failure.
 *
 * ── Why "checked", and why it ticks ───────────────────────────────────────
 * The time is when the page's one probe answered, stamped in the browser. It
 * is not repeated, so the words say "checked 5m ago" rather than claiming a
 * live heartbeat, and never "last check" — that is the product's name for the
 * pre-flight on step 4. The minute tick only keeps the relative words true
 * while the page sits open; it does not probe again.
 */
export function DetectionStatusPill({ guard, checkedAt = null, t }: {
    guard: GuardStatus | null;
    checkedAt?: number | null;
    t: TranslateFn;
}) {
    if (!guard) return null;
    if (guard.configured === false || guard.reachable === false) {
        return (
            <span
                // A status, not an alert: it is a standing condition rather
                // than something that just happened, and an assertive
                // announcement on every pane switch would be noise.
                role="status"
                className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full whitespace-nowrap bg-[color-mix(in_srgb,var(--error)_12%,transparent)] text-[var(--error-ink)] border border-[color-mix(in_srgb,var(--error)_45%,transparent)]"
            >
                <PlugZap className="w-[11px] h-[11px]" aria-hidden="true" />
                {guard.configured === false
                    ? t('admin.shield_guard_not_installed', 'Detection service not installed')
                    : t('admin.shield_guard_unreachable', 'Detection service not responding')}
            </span>
        );
    }
    return <RunningPill checkedAt={checkedAt} t={t} />;
}

/**
 * The healthy state. Deliberately not a live region: its words change every
 * minute, and a polite announcement each time would be noise.
 */
function RunningPill({ checkedAt, t }: { checkedAt: number | null; t: TranslateFn }) {
    const relative = useRelativeTime();
    const [, setTick] = useState(0);
    useEffect(() => {
        if (checkedAt == null) return undefined;
        const id = setInterval(() => setTick(n => n + 1), MS_PER_MINUTE);
        return () => clearInterval(id);
    }, [checkedAt]);

    const when = checkedAt != null ? relative(checkedAt) : '';
    return (
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full whitespace-nowrap bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success-ink)]">
            <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--success)]" />
            {when
                ? t('shield_shell.guard_running_checked', 'Detection running · checked {when}', { when })
                : t('shield_shell.guard_running', 'Detection running')}
        </span>
    );
}

export default DetectionStatusPill;
