import { Package, Upload, Users } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { OBJHEAD_FOLD } from '../../../shared/StudioSectionHeader';

/**
 * The header buttons of a Dev Solution: Publish (the one primary action),
 * Export and Manage access. Pure presentation; SolutionDetail owns the state.
 */

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]';
const BASE = `inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-[var(--radius-sm)] text-[13px] font-medium transition-colors motion-reduce:transition-none ${FOCUS}`;

export function PublishButton({ onClick, disabled, blocked }: { onClick: () => void; disabled: boolean; blocked: boolean }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            data-testid="solution-publish"
            title={blocked
                ? t('solutions.publish_blocked', 'Not while there are things to fix — or while the checks could not be run.')
                : undefined}
            className={`${BASE} disabled:opacity-50 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]`}
        >
            <Upload className="w-4 h-4" aria-hidden="true" />
            <span className={OBJHEAD_FOLD.action}>{t('solutions.publish', 'Publish')}</span>
        </button>
    );
}

export function HeaderExtras({ onExport, onAccess }: { onExport: () => void; onAccess: () => void }) {
    const { t } = useTranslation();
    const quiet = `${BASE} border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-card-hover)]`;
    return (
        <>
            <button type="button" onClick={onExport} data-testid="solution-export" className={quiet}>
                <Package className="w-4 h-4" aria-hidden="true" />
                <span className={OBJHEAD_FOLD.action}>{t('solutions.export', 'Export')}</span>
            </button>
            {/* Who can open this Solution. A Solution is not a project workspace,
                so its members are managed here rather than on /app/projects. */}
            <button
                type="button"
                onClick={onAccess}
                data-testid="solution-manage-access"
                aria-label={t('solutions.manage_access', 'Manage access')}
                className={quiet}
            >
                <Users className="w-4 h-4" aria-hidden="true" />
                <span className={OBJHEAD_FOLD.action}>{t('solutions.manage_access', 'Manage access')}</span>
            </button>
        </>
    );
}
