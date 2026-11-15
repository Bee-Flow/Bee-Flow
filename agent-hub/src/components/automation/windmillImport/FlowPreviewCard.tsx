import { AlertTriangle, Globe, KeyRound, Repeat, UserCog } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import type { Confidence, WindmillFlowPreview, WindmillWarning } from '@/api/windmillImport';

const CONFIDENCE_TONE: Record<Confidence, string> = {
    high: 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success-ink)]',
    medium: 'bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning-ink)]',
    low: 'bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning-ink)]',
    none: 'bg-[color-mix(in_srgb,var(--error)_14%,transparent)] text-[var(--error-ink)]',
};

/** The warnings a person must read before switching an import on, first; the rest after. */
const HEADLINE_CODES = ['trigger_switch_off', 'secret_removed', 'connection_needed', 'identity_change', 'outbound_host', 'ai_destination'];

function WarningIcon({ code }: { code: string }) {
    if (code === 'trigger_switch_off') return <Repeat size={12} className="shrink-0 mt-0.5" />;
    if (code === 'secret_removed' || code === 'connection_needed') return <KeyRound size={12} className="shrink-0 mt-0.5" />;
    if (code === 'identity_change') return <UserCog size={12} className="shrink-0 mt-0.5" />;
    if (code === 'outbound_host' || code === 'ai_destination') return <Globe size={12} className="shrink-0 mt-0.5" />;
    return <AlertTriangle size={12} className="shrink-0 mt-0.5" />;
}

export function sortedWarnings(warnings: WindmillWarning[]): WindmillWarning[] {
    const rank = (w: WindmillWarning) => {
        const i = HEADLINE_CODES.indexOf(w.code);
        return i === -1 ? HEADLINE_CODES.length : i;
    };
    return [...warnings].sort((a, b) => rank(a) - rank(b));
}

interface Props {
    flow: WindmillFlowPreview;
    selected: boolean;
    onToggle: () => void;
    disabled?: boolean;
}

/** One flow of the preview: what it is, how much converted, and what to read before importing it. */
export default function FlowPreviewCard({ flow, selected, onToggle, disabled = false }: Props) {
    const { t } = useTranslation();
    const c = flow.counts || {};
    const carried = (c.mapped ?? 0) + (c.pattern ?? 0) + (c.shim ?? 0);
    const open = flow.aiChecklist.length;
    const confidenceLabel: Record<Confidence, string> = {
        high: t('automation_import.confidence_high', 'High confidence'),
        medium: t('automation_import.confidence_medium', 'Medium confidence'),
        low: t('automation_import.confidence_low', 'Needs work'),
        none: t('automation_import.confidence_none', 'Not convertible as is'),
    };
    const checkboxId = `wm-flow-${flow.path}`;
    return (
        <li className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] p-3 text-[12px]">
            <div className="flex items-start gap-2">
                <input
                    id={checkboxId}
                    type="checkbox"
                    className="mt-0.5"
                    checked={selected}
                    disabled={disabled || !flow.importable}
                    onChange={onToggle}
                />
                <div className="min-w-0 flex-1">
                    <label htmlFor={checkboxId} className="font-semibold text-[var(--text-primary)] break-words">{flow.title}</label>
                    <div className="text-[11px] text-[var(--text-tertiary)] break-all">{flow.path}</div>
                </div>
                <span className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-medium ${CONFIDENCE_TONE[flow.confidence]}`}>{confidenceLabel[flow.confidence]}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--text-secondary)]">
                <span>{t('automation_import.count_carried', '{count} steps converted', { count: carried })}</span>
                <span>{t('automation_import.count_open', '{count} for AI or by hand', { count: open })}</span>
                {(c.unsupported ?? 0) > 0 && <span>{t('automation_import.count_unsupported', '{count} not supported', { count: c.unsupported })}</span>}
                <span>{t('automation_import.trigger_type', 'Starts: {type}', { type: flow.triggerType })}</span>
            </div>
            {!flow.importable && (
                <p className="mt-2 text-[11px] text-[var(--error-ink)]">
                    {t('automation_import.not_importable', 'This flow cannot be imported as is: {codes}', { codes: flow.validationErrors.join(', ') })}
                </p>
            )}
            {flow.outboundHosts.length > 0 && (
                <p className="mt-2 text-[11px] text-[var(--text-secondary)]">
                    {t('automation_import.outbound_hosts', 'Sends data to: {hosts}. Check these against your rules for outbound data.', { hosts: flow.outboundHosts.join(', ') })}
                </p>
            )}
            {flow.connections.length > 0 && (
                <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
                    {t('automation_import.connections', 'Connections to choose (no secret was carried over): {names}', { names: flow.connections.map((x) => x.path).join(', ') })}
                </p>
            )}
            {flow.warnings.length > 0 && (
                <details className="mt-2">
                    <summary className="cursor-pointer text-[11px] text-[var(--text-secondary)]">
                        {t('automation_import.warnings_summary', '{count} things to check', { count: flow.warnings.length })}
                    </summary>
                    <ul className="mt-1 space-y-1">
                        {sortedWarnings(flow.warnings).map((w, i) => (
                            <li key={`${w.code}-${i}`} className="flex gap-1.5 text-[11px] text-[var(--text-secondary)]">
                                <WarningIcon code={w.code} />
                                <span>{w.message}</span>
                            </li>
                        ))}
                    </ul>
                </details>
            )}
            {open > 0 && (
                <details className="mt-1">
                    <summary className="cursor-pointer text-[11px] text-[var(--text-secondary)]">{t('automation_import.checklist_summary', 'Open items')}</summary>
                    <ul className="mt-1 list-disc pl-5 space-y-0.5 text-[11px] text-[var(--text-secondary)]">
                        {flow.aiChecklist.map((i) => <li key={i.wmId}><span className="font-medium">{i.title}</span>{i.why ? `: ${i.why}` : ''}</li>)}
                    </ul>
                </details>
            )}
        </li>
    );
}
