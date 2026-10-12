import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { statusLabel, tokenFor, tokenForStep } from '../../../shared/statusTokens';

/**
 * Status icon + badge for a run, driven entirely by the shared status-token
 * table (agent-hub/src/components/shared/statusTokens.ts). Using tokenFor
 * here is what fixes the old bug where `awaiting_approval` fell through to a
 * gray "queued" Play icon — the token table maps it (and the
 * `awaiting_confirm` alias) to an amber ShieldQuestion. Unknown statuses
 * degrade to the neutral `idle` token instead of crashing.
 *
 * Both accept an optional `step`: a recorded run-step row, which lets the
 * table tell a step that was switched off (grey) from one that ran and found
 * nothing to do (amber). Pass it wherever the row is at hand; without it a
 * `skipped` status stays grey, because a bare status word carries no reason.
 */
export function RunStatusIcon({ status, step = null, size = 14, className = '' }) {
    const token = step ? tokenForStep(step) : tokenFor(status);
    const Icon = token.icon;
    return (
        <Icon
            size={size}
            data-testid="run-status-icon"
            data-status-key={token.labelKey}
            className={`${token.solid} ${token.spin ? 'animate-spin' : ''} flex-shrink-0 ${className}`}
        />
    );
}

/**
 * Pill badge for a run's status. For dry-runs we keep the status word
 * (e.g. "Success") and surface the dry-run nature with a separate
 * <DryRunBadge> so users see BOTH facts instead of "dry-run" masking the
 * outcome (the old behaviour).
 */
export function RunStatusBadge({ status, step = null }) {
    const { t } = useTranslation();
    const token = step ? tokenForStep(step) : tokenFor(status);
    return (
        <span
            data-testid="run-status-badge"
            data-status-key={token.labelKey}
            className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded ${token.badge}`}
        >
            {statusLabel(t, token)}
        </span>
    );
}

/** Small neutral "Dry-run" pill, shown alongside the status badge. */
export function DryRunBadge() {
    const { t } = useTranslation();
    return (
        <span className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)] border border-[var(--border-default)]">
            {t('run_status.dry_run', 'dry-run')}
        </span>
    );
}
