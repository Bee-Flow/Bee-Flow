import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Circle, Sparkles } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import { acknowledgeImportItems, fetchImportReport } from '@/api/windmillImport';
import type { ImportReportView } from '@/api/windmillImport';
import { PRIMARY_BTN, SECONDARY_BTN } from '../Builder/settings/settingsUi';
import { sortedWarnings } from './FlowPreviewCard';
import useWindmillInventory from './useWindmillInventory';

const importReportKey = (automationId: string) => ['automation', automationId, 'import-report'] as const;

interface Props {
    automationId: string;
    /** Opens the AI automation builder on this draft with the briefing in its input box (never sent by itself). */
    onCompleteWithAi?: (automationId: string, brief: string) => void;
    onOpen?: (automationId: string) => void;
}

/** Where the activation gate stands: open items, and the dry run of this version. */
function GateStatus({ gate }: { gate: ImportReportView['gate'] }) {
    const { t } = useTranslation();
    const open = gate.open;
    if (gate.cleared) return <p className="text-[11px] text-[var(--success-ink)]">{t('automation_import.gate_cleared', 'This automation has been live; the import checks are done.')}</p>;
    return (
        <ul className="space-y-1">
            <li className="flex items-center gap-1.5">
                {open.length === 0 ? <CheckCircle2 size={13} className="text-[var(--success-ink)]" /> : <Circle size={13} className="text-[var(--warning-ink)]" />}
                <span>{open.length === 0
                    ? t('automation_import.gate_checklist_done', 'Every open item is done or marked as handled.')
                    : t('automation_import.gate_checklist_open', '{count} items still to convert', { count: open.length })}</span>
            </li>
            <li className="flex items-center gap-1.5">
                {gate.dryRunRequired ? <Circle size={13} className="text-[var(--warning-ink)]" /> : <CheckCircle2 size={13} className="text-[var(--success-ink)]" />}
                <span>{gate.dryRunRequired
                    ? t('automation_import.gate_dry_run_needed', 'A dry run of this version without errors is needed before it can be switched on.')
                    : t('automation_import.gate_dry_run_done', 'A dry run of this version passed.')}</span>
            </li>
        </ul>
    );
}

/**
 * The migration report of one imported draft: what is still open, whether a
 * dry run of this version passed, and what to check (secrets left out,
 * outbound hosts, identity change, the Windmill trigger to switch off). The
 * same facts the activation gate reads on the server.
 */
export default function ImportReportPanel({ automationId, onCompleteWithAi, onOpen }: Props) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const report = useQuery({ queryKey: importReportKey(automationId), queryFn: () => fetchImportReport(automationId) });
    const inventory = useWindmillInventory();
    const ack = useMutation({
        mutationFn: (wmIds: string[]) => acknowledgeImportItems(automationId, wmIds),
        onSuccess: (view: ImportReportView) => queryClient.setQueryData(importReportKey(automationId), view),
    });

    if (report.isPending) return <p className="text-[11px] text-[var(--text-tertiary)]">{t('automation_import.report_loading', 'Loading the import report…')}</p>;
    if (report.isError || !report.data) return <p className="text-[11px] text-[var(--error-ink)]">{t('automation_import.report_failed', 'The import report could not be read.')}</p>;

    const view = report.data;
    const open = view.gate.open;
    const warnings = sortedWarnings(view.report.warnings ?? []);
    // The same flow still listens to this Nextcloud in Windmill: both would run on every event.
    const stillActive = !!view.windmillPath && !!inventory.data?.flows.some((f) => f.active && f.path === view.windmillPath);
    return (
        <section aria-label={t('automation_import.report_title', 'Import report')} className="space-y-2 text-[12px]">
            {stillActive && (
                <p role="status" className="flex items-start gap-1.5 rounded-md border border-[var(--warning-ink)] px-2 py-1 text-[var(--warning-ink)]">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                    <span>{t('automation_import.windmill_still_active', 'This flow is still active in Windmill on this Nextcloud. Switch its trigger off in Windmill before you switch this automation on, or every event runs twice.')}</span>
                </p>
            )}
            <GateStatus gate={view.gate} />
            {open.length > 0 && (
                <ul className="space-y-1">
                    {open.map((item) => (
                        <li key={item.wmId} className="flex items-center justify-between gap-2 rounded-md border border-[var(--border-default)] px-2 py-1">
                            <span className="min-w-0 break-words">{item.title}</span>
                            <button
                                type="button"
                                className={SECONDARY_BTN}
                                disabled={ack.isPending}
                                onClick={() => ack.mutate([item.wmId])}
                            >
                                {t('automation_import.mark_handled', 'Mark as handled')}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <div className="flex flex-wrap gap-2">
                {view.brief && onCompleteWithAi && (
                    <button type="button" className={PRIMARY_BTN} onClick={() => onCompleteWithAi(automationId, view.brief as string)}>
                        <Sparkles size={13} />
                        {t('automation_import.complete_with_ai', 'Complete with AI')}
                    </button>
                )}
                {onOpen && (
                    <button type="button" className={SECONDARY_BTN} onClick={() => onOpen(automationId)}>
                        {t('automation_import.open_in_builder', 'Open in the builder')}
                    </button>
                )}
            </div>
            {view.brief && onCompleteWithAi && (
                <p className="text-[11px] text-[var(--text-tertiary)]">
                    {t('automation_import.ai_privacy', 'The briefing, including the source of the open items, goes to your organisation\'s AI model when you send it. You send it yourself; nothing is switched on.')}
                </p>
            )}
            {warnings.length > 0 && (
                <ul className="space-y-1 text-[11px] text-[var(--text-secondary)]">
                    {warnings.map((w, i) => <li key={`${w.code}-${i}`}>{w.message}</li>)}
                </ul>
            )}
        </section>
    );
}
