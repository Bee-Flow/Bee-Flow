import { Loader2, Check, AlertTriangle, ShieldAlert } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * ScanLog: what a scan looked at, source by source (behind "Show details" on
 * the Find repeating work page). Each row says what was (or is being) read,
 * any personal-data categories the Privacy Shield flagged, and, when a source
 * was blocked by the Privacy Shield, that it was skipped and why. Read-only,
 * theme status tokens only.
 *
 * @param {Array} steps   - [{ tool, integration, status, piiCategories, blockedReason }]
 * @param {(id:string)=>string} labelFor - integration id → display label
 */
export default function ScanLog({ steps = [], labelFor = (x) => x }) {
    const { t } = useTranslation();
    if (!steps.length) return null;
    return (
        <div className="rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] divide-y divide-[var(--border-default)]" data-testid="scan-log">
            {steps.map((s) => {
                const blocked = s.status === 'blocked';
                const verb = blocked
                    ? t('routines.repeating.logSkipped', 'Skipped')
                    : (s.status === 'scanning' ? t('routines.repeating.logReading', 'Reading') : t('routines.repeating.logRead', 'Read'));
                return (
                    <div key={s.tool} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                        {s.status === 'scanning' && <Loader2 size={12} className="animate-spin text-[var(--text-tertiary)] flex-shrink-0" aria-hidden="true" />}
                        {s.status === 'done' && <Check size={12} className="text-[var(--success)] flex-shrink-0" aria-hidden="true" />}
                        {blocked && (s.blockedReason
                            ? <ShieldAlert size={12} className="text-[var(--warning)] flex-shrink-0" aria-hidden="true" />
                            : <AlertTriangle size={12} className="text-[var(--warning)] flex-shrink-0" aria-hidden="true" />)}
                        <span className="text-[var(--text-secondary)] flex-1 truncate">
                            {verb} {labelFor(s.integration)}
                            <span className="text-[var(--text-tertiary)]"> · {s.tool.replace(/_/g, ' ')}</span>
                            {blocked && (
                                <span className="text-[var(--warning)]">
                                    {' · '}{s.blockedReason || t('routines.repeating.logBlocked', 'blocked by Privacy Shield')}
                                </span>
                            )}
                        </span>
                        {s.piiCategories?.length > 0 && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--warning)] flex-shrink-0">
                                {s.piiCategories.join(', ')}
                            </span>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
