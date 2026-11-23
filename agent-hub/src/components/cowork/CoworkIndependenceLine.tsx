/**
 * How independent an approved plan is, as ONE line in the plan card (./CoworkPlanPanel.tsx): "Asks before sending ·
 * 2 steps go on their own · Change". The line opens to the full choice (./CoworkIndependence.tsx, with the trust per
 * step under it, ./CoworkTrust.tsx), which reads and saves as before. Both share their reads with the line, so the
 * line follows a change at once.
 *
 * A level that can no longer be honoured opens the choice by itself: that line has something to say.
 */
import { ShieldCheck } from 'lucide-react';
import CoworkIndependence from './CoworkIndependence';
import { useCoworkIndependence, useCoworkTrust } from '@/api/coworkIndependence';
import type { IndependenceState, TrustState } from '@/api/coworkIndependence';
import type { TranslateFn } from '@/hooks/useTranslation';

/** The level in a few words, or that it cannot run as chosen. */
function levelWords(state: IndependenceState, t: TranslateFn): string {
    if (state.level === null) return t('cowork_detail.autonomy.cannot_run', 'Cannot run as chosen');
    if (state.level === 'asks_everything') return t('cowork_detail.autonomy.asks_everything', 'Asks about everything');
    if (state.level === 'asks_before_sending') return t('cowork_detail.autonomy.asks_before_sending', 'Asks before sending');
    return t('cowork_detail.autonomy.on_its_own', 'Goes on its own');
}

/** "2 steps go on their own", or nothing while no step was let go. */
function trustWords(trust: TrustState | undefined, t: TranslateFn): string | null {
    const count = Array.isArray(trust?.entries) ? trust.entries.filter((e) => e.trusted).length : 0;
    if (count === 0) return null;
    return t(
        count === 1 ? 'cowork_detail.autonomy.trusted' : 'cowork_detail.autonomy.trusted_plural',
        count === 1 ? '{count} step goes on its own' : '{count} steps go on their own',
        { count },
    );
}

export default function CoworkIndependenceLine({ coworkId, t }: { coworkId: string; t: TranslateFn }) {
    const state = useCoworkIndependence(coworkId, true).query.data;
    const trust = useCoworkTrust(coworkId).query.data;
    if (!state) return null;
    const words = [levelWords(state, t), trustWords(trust, t)].filter(Boolean).join(' · ');
    return (
        <details data-testid="cowork-autonomy" open={state.level === null} className="pt-2 border-t border-[var(--border-subtle)]">
            <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12.5px] text-[var(--text-secondary)]">
                <ShieldCheck aria-hidden="true" className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
                <span data-testid="cowork-autonomy-line">{words}</span>
                <span aria-hidden="true" className="text-[var(--text-tertiary)]">·</span>
                <span className="font-medium underline underline-offset-2 text-[var(--accent-primary)]">{t('cowork_detail.autonomy.change', 'Change')}</span>
            </summary>
            <div className="pt-2">
                <CoworkIndependence coworkId={coworkId} t={t} />
            </div>
        </details>
    );
}
