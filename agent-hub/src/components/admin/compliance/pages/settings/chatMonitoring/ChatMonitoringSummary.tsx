import React, { useState } from 'react';
import { useTranslation, type TranslateFn } from '../../../../../../hooks/useTranslation';
import { useChatMonitoringSummary, type Cell, type SurfaceFigures } from '../../../data/useChatMonitoring';
import { ActionButton } from './formAtoms';
import { kindLabel, surfaceLabel } from './chatMonitoringLabels';

/**
 * The figures, per chat type, as the server already suppressed them: every
 * cell is 0, a number, "<5" or "hidden" (or a dash where a percentage has
 * nothing to divide by), and a chat type used by too few people shows one
 * sentence instead of a row. No drill-down exists.
 *
 * The table opens on request, never on its own: every read is recorded in
 * the access log, and visiting the settings page is not a reason to read.
 */

const TH = 'px-2 py-1.5 text-left text-[10px] uppercase tracking-[.06em] font-semibold text-[var(--text-tertiary)] whitespace-nowrap';
const TD = 'px-2 py-1.5 text-xs text-[var(--text-primary)] tabular-nums whitespace-nowrap';

function CellView({ t, value, pct = false }: { t: TranslateFn; value: Cell | undefined; pct?: boolean }) {
    // Nothing to divide by (no personal data found, say): not a figure at all.
    if (value === null || value === undefined) return <span className="text-[var(--text-tertiary)]" data-cell="na">{'—'}</span>;
    if (value === 'hidden') {
        return (
            <span className="text-[var(--text-tertiary)]" title={t('chat_monitoring.summary.hidden_hint', 'Hidden so the other figures cannot reveal a small number.')} data-cell="hidden">
                {t('chat_monitoring.summary.hidden', 'hidden')}
            </span>
        );
    }
    if (value === '<5') return <span data-cell="lt5">{t('chat_monitoring.summary.lt5', '<5')}</span>;
    return <span data-cell="n">{pct ? `${value}%` : String(value)}</span>;
}

/** Scan failed = open + closed: a sum when both are numbers, the two cells side by side otherwise. */
function FailedCell({ t, pct }: { t: TranslateFn; pct: Record<string, Cell> }) {
    const open = pct.failed_open;
    const closed = pct.failed_closed;
    if (typeof open === 'number' && typeof closed === 'number') return <CellView t={t} value={open + closed} pct />;
    if (open === 0) return <CellView t={t} value={closed} pct />;
    if (closed === 0) return <CellView t={t} value={open} pct />;
    return (<><CellView t={t} value={open} pct />{' + '}<CellView t={t} value={closed} pct /></>);
}

function statusSentence(t: TranslateFn, f: SurfaceFigures): string | null {
    switch (f.status) {
        case 'suppressed': return t('chat_monitoring.summary.suppressed', 'Hidden: fewer than {k} people used this in the period.', { k: f.k ?? 5 });
        case 'no_full_period': return t('chat_monitoring.summary.no_full_period', 'No complete week yet.');
        case 'no_data': return t('chat_monitoring.summary.no_data', 'No counts yet.');
        default: return null;
    }
}

function SurfaceRow({ t, surface, f }: { t: TranslateFn; surface: string; f: SurfaceFigures }) {
    const sentence = statusSentence(t, f);
    return (
        <tr className="border-t border-[var(--border-default)]" data-testid={`cm-summary-row-${surface}`}>
            <th scope="row" className={`${TD} font-medium text-left`}>{surfaceLabel(t, surface)}</th>
            {sentence
                ? <td colSpan={7} className={`${TD} text-[var(--text-tertiary)] whitespace-normal`} data-testid={`cm-summary-status-${surface}`}>{sentence}</td>
                : (
                    <>
                        <td className={TD}><CellView t={t} value={f.turns} /></td>
                        <td className={TD}><CellView t={t} value={f.pct.scanned} pct /></td>
                        <td className={TD}><CellView t={t} value={f.pct.protected_of_found} pct /></td>
                        <td className={TD}><CellView t={t} value={f.pct.blocked} pct /></td>
                        <td className={TD}><CellView t={t} value={f.pct.sent_unprotected} pct /></td>
                        <td className={TD}><FailedCell t={t} pct={f.pct} /></td>
                        <td className={TD}><CellView t={t} value={f.pct.unscanned_external} pct /></td>
                    </>
                )}
        </tr>
    );
}

function KindsList({ t, surface, f }: { t: TranslateFn; surface: string; f: SurfaceFigures }) {
    if (f.status !== 'shown' || f.kinds.status === 'off') return null;
    return (
        <div className="flex flex-col gap-1" data-testid={`cm-summary-kinds-${surface}`}>
            <span className="text-[11px] font-semibold text-[var(--text-secondary)]">{`${surfaceLabel(t, surface)} · ${t('chat_monitoring.summary.col_kinds', 'Kinds found')}`}</span>
            {f.kinds.status === 'suppressed'
                ? <span className="text-[11px] text-[var(--text-tertiary)]">{t('chat_monitoring.summary.suppressed', 'Hidden: fewer than {k} people used this in the period.', { k: f.kinds.k ?? 10 })}</span>
                : (
                    <ul className="m-0 pl-4 list-disc text-[11px] text-[var(--text-secondary)]">
                        {f.kinds.rows.map((r) => (
                            <li key={r.kind}>
                                {`${kindLabel(t, r.kind)}: `}
                                <CellView t={t} value={r.protected} />{` ${t('chat_monitoring.summary.kind_protected', 'protected')}, `}
                                <CellView t={t} value={r.exposed} />{` ${t('chat_monitoring.summary.kind_exposed', 'sent anyway')}`}
                            </li>
                        ))}
                    </ul>
                )}
        </div>
    );
}

function DaysToggle({ t, days, onDays }: { t: TranslateFn; days: 30 | 90; onDays: (d: 30 | 90) => void }) {
    const button = (d: 30 | 90, label: string) => (
        <button
            type="button"
            aria-pressed={days === d}
            onClick={() => onDays(d)}
            className={`h-7 px-2.5 text-[11px] font-medium rounded-[8px] ${days === d ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}
            data-testid={`cm-summary-days-${d}`}
        >
            {label}
        </button>
    );
    return (
        <div className="inline-flex rounded-[10px] border border-[var(--border-default)] p-0.5">
            {button(30, t('chat_monitoring.summary.days_30', '30 days'))}
            {button(90, t('chat_monitoring.summary.days_90', '90 days'))}
        </div>
    );
}

function Table({ t, rows }: { t: TranslateFn; rows: Array<{ surface: string; figures: SurfaceFigures }> }) {
    return (
        <div className="overflow-x-auto rounded-[10px] border border-[var(--border-default)]">
            <table className="w-full border-collapse">
                <thead>
                    <tr>
                        <th scope="col" className={TH}>{t('chat_monitoring.summary.col_surface', 'Chat type')}</th>
                        <th scope="col" className={TH}>{t('chat_monitoring.summary.col_turns', 'Messages')}</th>
                        <th scope="col" className={TH}>{t('chat_monitoring.summary.col_scanned', 'Scanned')}</th>
                        <th scope="col" className={TH}>{t('chat_monitoring.summary.col_protected', 'Protected when found')}</th>
                        <th scope="col" className={TH}>{t('chat_monitoring.summary.col_blocked', 'Blocked')}</th>
                        <th scope="col" className={TH}>{t('chat_monitoring.summary.col_sent_unprotected', 'Sent anyway')}</th>
                        <th scope="col" className={TH}>{t('chat_monitoring.summary.col_failed', 'Scan failed')}</th>
                        <th scope="col" className={TH}>{t('chat_monitoring.summary.col_unscanned_external', 'Not scanned, external model')}</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((r) => <SurfaceRow key={r.surface} t={t} surface={r.surface} f={r.figures} />)}
                </tbody>
            </table>
        </div>
    );
}

export default function ChatMonitoringSummary({ onOpenChecks = null }: { onOpenChecks?: (() => void) | null }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [days, setDays] = useState<30 | 90>(30);
    const summary = useChatMonitoringSummary(days, { enabled: open });
    const auditNote = <p className="m-0 text-[11px] text-[var(--text-tertiary)]">{t('chat_monitoring.summary.audit_note', 'Opening this table is recorded in the access log.')}</p>;

    if (!open) {
        return (
            <div className="flex flex-col gap-1" data-testid="cm-summary-closed">
                <ActionButton size="sm" className="w-fit" onClick={() => setOpen(true)} data-testid="cm-summary-open">
                    {t('chat_monitoring.summary.show', 'Show the figures')}
                </ActionButton>
                {auditNote}
            </div>
        );
    }
    const rows = summary.data?.surfaces ?? [];
    return (
        <div className="flex flex-col gap-2" data-testid="cm-summary">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-[var(--text-primary)]">{t('chat_monitoring.summary.title', 'Last {days} days', { days })}</span>
                <DaysToggle t={t} days={days} onDays={setDays} />
            </div>
            {summary.isPending && <p className="m-0 text-[11px] text-[var(--text-tertiary)]">{t('chat_monitoring.summary.loading', 'Reading the figures…')}</p>}
            {summary.isError && <p role="alert" className="m-0 text-[11px] text-[var(--text-secondary)]" data-testid="cm-summary-error">{t('chat_monitoring.summary.failed', 'The figures could not be read. Try again later.')}</p>}
            {rows.length > 0 && <Table t={t} rows={rows} />}
            {rows.map((r) => <KindsList key={r.surface} t={t} surface={r.surface} f={r.figures} />)}
            <ul className="m-0 pl-4 list-disc text-[11px] text-[var(--text-tertiary)]">
                <li>{t('chat_monitoring.summary.weeks_note', 'Employee chats are shown in complete weeks only.')}</li>
                <li>{t('chat_monitoring.summary.approx', 'Counts are approximate.')}</li>
                <li>{t('chat_monitoring.summary.audit_note', 'Opening this table is recorded in the access log.')}</li>
            </ul>
            {onOpenChecks && (
                <button type="button" onClick={onOpenChecks} className="w-fit text-[11px] font-medium text-[var(--text-primary)] underline underline-offset-2" data-testid="cm-summary-checks">
                    {t('chat_monitoring.summary.checks_link', 'See the checks')}
                </button>
            )}
        </div>
    );
}
