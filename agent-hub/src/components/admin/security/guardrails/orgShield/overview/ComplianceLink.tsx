import { ArrowUpRight, CircleCheck, Scale, TriangleAlert } from 'lucide-react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';

/**
 * "Linked to Compliance" — the two framework checks this document drives.
 *
 * Saving the shield emits `DLP_CONFIG_CHANGED`, which re-runs the GDPR Art. 32
 * check and the ISO A.8.11/A.8.12 check straight away instead of waiting for
 * the six-hourly sweep. The Compliance Center's own fix text points back
 * here, so the link exists in both directions.
 *
 * Deliberately NOT a live fetch. The Compliance Hub is separately licensed,
 * and an Overview that blocks on it (or shows an error box on a plan without
 * it) would be worse than one that states the relationship and links out. The
 * pass/attention state comes from the shield state itself, which is the same
 * input those checks read.
 */

/** "28 Sep 2026, 15:48" in the reader's own locale; the raw value if it does not parse. */
export function formatChanged(updatedAt: string | number): string {
    const date = new Date(updatedAt);
    if (Number.isNaN(date.getTime())) return String(updatedAt);
    return new Intl.DateTimeFormat(undefined, {
        day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(date);
}

interface Props {
    f: { enabled: boolean; piiCategories?: string[] };
    updatedAt?: string | number | null;
    updatedBy?: string | null;
    onOpen?: () => void;
    t: TranslateFn;
}

export default function ComplianceLink({ f, updatedAt, updatedBy, onOpen, t }: Props) {
    // Mirrors what the Art. 32 "Data Loss Prevention active" check asks: is
    // the shield on, and is it actually looking for anything?
    const dlpFullyActive = !!f.enabled && (f.piiCategories?.length || 0) > 0;
    const rows = [
        {
            id: 'gdpr',
            ok: dlpFullyActive,
            label: dlpFullyActive
                ? t('admin.shield_compliance_dlp_ok', 'Data-loss prevention active')
                : t('admin.shield_compliance_dlp_partial', 'Data-loss prevention only partly active'),
            ref: 'GDPR Art. 32',
        },
        // Logging runs whether or not content scanning does — the minimal
        // egress row is always written.
        { id: 'iso', ok: true, label: t('admin.shield_compliance_logging', 'Logging & monitoring'), ref: 'ISO A.8.11 / A.8.12' },
    ];

    return (
        <section
            aria-labelledby="org-shield-compliance"
            className="rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] shadow-[var(--shadow-sm)] px-4 py-3.5 flex flex-col gap-2"
        >
            <div className="flex items-center gap-2">
                <Scale className="w-[15px] h-[15px] text-[var(--text-secondary)]" aria-hidden="true" />
                <h4 id="org-shield-compliance" className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">
                    {t('shield_overview.compliance_title', 'Linked to Compliance')}
                </h4>
            </div>
            <p className="m-0 text-xs leading-[18px] text-[var(--text-secondary)]">
                {t('shield_overview.compliance_desc', 'Saving here re-runs these checks in the Compliance Center.')}
            </p>

            {rows.map(row => {
                const Icon = row.ok ? CircleCheck : TriangleAlert;
                return (
                    <button
                        key={row.id}
                        type="button"
                        onClick={() => onOpen?.()}
                        className="flex items-center gap-2.5 py-2 text-left border-t border-[var(--border-subtle)] hover:opacity-80"
                    >
                        <Icon
                            className={row.ok ? 'w-[15px] h-[15px] shrink-0 text-[var(--success-ink)]' : 'w-[15px] h-[15px] shrink-0 text-[var(--warning-ink)]'}
                            aria-hidden="true"
                        />
                        <span className="flex-1 min-w-0">
                            <span className="block text-[13px] font-medium text-[var(--text-primary)] truncate">{row.label}</span>
                            <span className="block text-[11px] text-[var(--text-tertiary)] font-mono">{row.ref}</span>
                            {/* The state in words too, so it is not carried by the icon's colour alone. */}
                            <span className="sr-only">
                                {` · ${row.ok ? t('admin.shield_compliance_ok', 'in order') : t('admin.shield_compliance_attention', 'needs attention')}`}
                            </span>
                        </span>
                        <ArrowUpRight className="w-[13px] h-[13px] shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                    </button>
                );
            })}

            {/* Who last changed this policy. `updatedBy` is a user id on the
                document; the server does not hydrate it to a name, so the id
                is what we show rather than inventing one. */}
            {updatedAt && (
                <p className="m-0 pt-2 text-[11px] leading-4 text-[var(--text-tertiary)] border-t border-[var(--border-subtle)]">
                    {t('admin.shield_last_changed', 'Last changed {when}', { when: formatChanged(updatedAt) })}
                    {updatedBy ? ` · ${updatedBy}` : ''}
                </p>
            )}
        </section>
    );
}
