import { CheckCircle2, Loader2, RefreshCw, X } from 'lucide-react';
import { useTranslation } from '../../../hooks/useTranslation';
import UpgradeMappingsDialog from './UpgradeMappingsDialog';
import useMappingsUpgradeOnOpen from './useMappingsUpgradeOnOpen';
import { PRIMARY_BTN, SECONDARY_BTN } from './settings/settingsUi';

type Row = Record<string, unknown>;

/**
 * The builder's offer to update an automation's mappings when it is opened
 * (M8b; the rules are useMappingsUpgradeOnOpen's): a strip over the canvas
 * with Update (the dry run and apply of UpgradeMappingsDialog) and Later, or,
 * after the organisation's update on open saved a new version, "Mappings
 * updated · Undo". Renders nothing otherwise.
 */
export default function MappingsUpgradeBanner({ automation, active, pristine, onApplied, onSuperseded }: {
    automation: Row | null | undefined;
    active: boolean;
    pristine: boolean;
    onApplied: (row: Row) => void;
    onSuperseded?: () => void;
}) {
    const { t } = useTranslation();
    const u = useMappingsUpgradeOnOpen({ automation, active, pristine, onApplied, onSuperseded });
    // Floating over the bottom of the canvas, like the validation pill: the
    // Editor's own header stays where it is.
    const strip = 'absolute bottom-4 left-1/2 -translate-x-1/2 z-30 w-max max-w-[calc(100%-2rem)] flex items-center gap-2 px-3 py-2 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] shadow-lg text-xs text-[var(--text-primary)]';
    const n = u.notice;
    return (
        <>
            {u.banner && (
                <div className={strip} role="region" aria-label={t('mapping.upgrade.banner_label', 'Update mappings')} data-testid="mappings-upgrade-banner">
                    <RefreshCw className="w-3.5 h-3.5 shrink-0 text-[var(--text-secondary)]" aria-hidden />
                    <span className="flex-1 min-w-0">{t('mapping.upgrade.banner', 'This automation can be updated to the new mappings.')}</span>
                    <button type="button" onClick={u.openDialog} className={PRIMARY_BTN}>{t('mapping.upgrade.banner_update', 'Update')}</button>
                    <button type="button" onClick={u.later} className={SECONDARY_BTN}>{t('mapping.upgrade.banner_later', 'Later')}</button>
                </div>
            )}
            {n && (
                <div className={strip} role="status" data-testid="mappings-upgrade-notice">
                    {n.state === 'undoing'
                        ? <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-[var(--text-secondary)]" aria-hidden />
                        : <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-[var(--success)]" aria-hidden />}
                    <span className="flex-1 min-w-0">
                        {n.state === 'undone' && t('mapping.upgrade.auto_undone', 'The mappings are back as they were.')}
                        {n.state === 'undo_failed' && <span className="text-[var(--error)]">{t('mapping.upgrade.auto_undo_failed', 'Could not undo the update. You can restore the previous version under Saved versions.')}</span>}
                        {(n.state === 'applied' || n.state === 'undoing') && t('mapping.upgrade.auto_applied', 'Mappings updated ({count} field(s))', { count: n.count })}
                    </span>
                    {n.state === 'applied' && n.previousVersionId && (
                        <button type="button" onClick={u.undo} className={SECONDARY_BTN}>{t('mapping.upgrade.auto_undo', 'Undo')}</button>
                    )}
                    <button type="button" onClick={u.dismissNotice} aria-label={t('common.close', 'Close')} className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                        <X className="w-3.5 h-3.5" aria-hidden />
                    </button>
                </div>
            )}
            {u.dialogOpen && u.automationId && (
                <UpgradeMappingsDialog open automationId={u.automationId} onClose={u.closeDialog} onApplied={u.onDialogApplied} />
            )}
        </>
    );
}
