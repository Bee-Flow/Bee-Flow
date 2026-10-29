import { ArrowLeft, FileJson, Pencil } from 'lucide-react';
import type React from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import ScoreRing from '../../shared/ScoreRing';
import StatusPill from '../../shared/StatusPill';
import QuestionnaireImport from './QuestionnaireImport';
import type { CustomFramework } from '../CustomFrameworksPage.types';

// The framework card and the open framework's header bar of CustomFrameworksPage.

export const SECONDARY_BUTTON = 'inline-flex items-center gap-1 px-[9px] py-1 rounded-lg border border-[var(--border-default)] text-[12px] font-medium text-[var(--text-primary)] bg-[var(--bg-card)] disabled:opacity-60';
interface FrameworkDetailHeaderProps {
    t: TranslateFn;
    selected: CustomFramework;
    exportUrl: string | null | undefined;
    exportsEnabled: boolean;
    importBusy: boolean;
    onImport: React.ComponentProps<typeof QuestionnaireImport>['onImport'];
    onBack: () => void;
    onEdit: () => void;
}

/** The open framework's bar: back, name, code and status, then import, the answer pack and Edit. */
export function FrameworkDetailHeader({ t, selected, exportUrl, exportsEnabled, importBusy, onImport, onBack, onEdit }: FrameworkDetailHeaderProps) {
    return (
        <div className="flex items-center gap-2 flex-wrap">
            <button type="button" className={SECONDARY_BUTTON} onClick={onBack} data-testid="custom-back">
                <ArrowLeft size={12} aria-hidden="true" />{t('compliance.custom_back', 'All frameworks')}
            </button>
            <span className="font-semibold text-[13px] truncate" data-testid="custom-detail-name">{selected.name}</span>
            <span className="font-mono text-[11px] text-[var(--text-tertiary)]">{selected.code}</span>
            <StatusPill tone={selected.status === 'active' ? 'success' : 'neutral'} testId="custom-detail-status">
                {t(`compliance.custom_status_fw_${selected.status}`, selected.status === 'active' ? 'Active' : 'Draft')}
            </StatusPill>
            <div className="ml-auto flex items-center gap-2">
                <QuestionnaireImport onImport={onImport} busy={importBusy} />
                {exportUrl && exportsEnabled && (
                    <a className={SECONDARY_BUTTON} href={exportUrl} data-testid="custom-export">
                        <FileJson size={12} aria-hidden="true" />{t('compliance.custom_export', 'Answer pack (JSON)')}
                    </a>
                )}
                <button type="button" className={SECONDARY_BUTTON} onClick={onEdit} data-testid="custom-edit">
                    <Pencil size={12} aria-hidden="true" />{t('common.edit', 'Edit')}
                </button>
            </div>
        </div>
    );
}

/** One framework on the list: score, name, code and reference, item and expiring counts, status. */
export function FrameworkCard({ t, f, expiring, onOpen }: { t: TranslateFn; f: CustomFramework; expiring: number | null; onOpen: () => void }) {
    return (
                <button
                    type="button"
                    onClick={onOpen}
                    className="rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] px-3.5 py-3 flex items-center gap-3 text-left hover:bg-[var(--bg-secondary)] [box-shadow:var(--shadow-sm)]"
                    data-testid="custom-card"
                    data-framework={f.id}
                >
                    <ScoreRing score={f.score} size={36} label={f.name} testId="custom-card-score" />
                    <div className="min-w-0 flex flex-col gap-0.5">
                        <span className="font-semibold truncate">{f.name}</span>
                        <span className="font-mono text-[10px] text-[var(--text-tertiary)] truncate">{f.code}{f.reference ? ` · ${f.reference}` : ''}</span>
                        <span className="text-[11px] text-[var(--text-secondary)]">
                            {typeof f.checks_count === 'number' && t('compliance.custom_card_items', '{n} items', { n: f.checks_count })}
                            {expiring !== null && expiring > 0 && (
                                <span data-testid="custom-card-expiring">{typeof f.checks_count === 'number' ? ' · ' : ''}{t('compliance.custom_card_expiring', '{n} expiring', { n: expiring })}</span>
                            )}
                        </span>
                    </div>
                    <StatusPill className="ml-auto" tone={f.status === 'active' ? 'success' : 'neutral'} testId="custom-card-status">
                        {t(`compliance.custom_status_fw_${f.status}`, f.status === 'active' ? 'Active' : 'Draft')}
                    </StatusPill>
                </button>
    );
}
