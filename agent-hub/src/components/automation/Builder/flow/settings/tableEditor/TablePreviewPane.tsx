import { AlertTriangle, Loader2 } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import type { TablePreviewState } from '@/hooks/automationBuilder/useTablePreview';
import type { Finding, TablePreviewOk } from '@/api/queries/automation/tablePreview';
import { hintTextClass } from '../formStyles';
import type { Translate } from './opHelp';

const CELL_CHARS = 80;

/** The preview's own warnings in plain words. Anything else the server says is shown as it is. */
function warningText(message: string, t: Translate): string {
    const lower = message.toLowerCase();
    if (lower.includes('preview_salt') || lower.includes('fixed secret')) {
        return t('automation_tables.preview.warn_salt', 'The preview uses a fixed secret, so the codes are not the codes a real run makes.');
    }
    if (lower.includes('rules_from_runtime') || lower.includes('applied when the automation runs')) {
        return t('automation_tables.preview.warn_rules_from', 'The rules from an earlier step are applied when the automation runs, not in this preview.');
    }
    return message;
}

function cell(value: unknown): string {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return text.length > CELL_CHARS ? `${text.slice(0, CELL_CHARS - 1)}…` : text;
}

function PreviewResult({ res, tr }: { res: TablePreviewOk; tr: Translate }) {
    const { t } = useTranslation();
    return (

        <>
            <p className="text-[11px] text-[var(--text-secondary)]">
                {res.rowCount === 1
                    ? t('automation_tables.preview.rows_one', '1 row, {columns} columns. The first rows are shown.', { columns: res.columns.length })
                    : t('automation_tables.preview.rows', '{rows} rows, {columns} columns. The first rows are shown.', { rows: res.rowCount, columns: res.columns.length })}
                {res.inputCapped && ` ${t('automation_tables.preview.capped', 'The preview works on the first {count} rows of the table only.', { count: res.inputRows })}`}
            </p>
            {res.warnings.map(w => <p key={w} className="text-[11px] text-amber-600 dark:text-amber-400">{warningText(w, tr)}</p>)}
            {res.rows.length === 0 ? (
                <p className="text-[11px] text-[var(--text-tertiary)]">{t('automation_tables.preview.empty', 'No rows are left.')}</p>
            ) : (
                <div className="max-h-72 overflow-auto rounded border border-[var(--border-default)]">
                    <table className="w-full border-collapse text-[11px]">
                        <thead className="sticky top-0 bg-[var(--bg-secondary)]">
                            <tr>{res.columns.map(c => <th key={c.key} scope="col" className="whitespace-nowrap px-2 py-1 text-left font-medium text-[var(--text-secondary)]">{c.label || c.key}</th>)}</tr>
                        </thead>
                        <tbody>
                            {res.rows.map((row, r) => (
                                <tr key={r} className="border-t border-[var(--border-default)]">
                                    {res.columns.map(c => <td key={c.key} className="max-w-[16rem] truncate whitespace-nowrap px-2 py-1 text-[var(--text-primary)]">{cell(row[c.key])}</td>)}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {res.segments && res.segments.length > 0 && (
                <p className="text-[11px] text-[var(--text-secondary)]">
                    {t('automation_tables.preview.segments', 'Segments that are large enough: {list}', { list: res.segments.map(s => `${s.label} (${s.n})`).join(', ') })}
                </p>
            )}
        </>
    );
}

interface Props {
    state: TablePreviewState;
    /** There is a table of an earlier run to preview with. */
    hasSource: boolean;
    /** Title of the operation the preview stops at; empty for the whole step. */
    upTo?: string;
    /** Findings that are not tied to a place in the form. */
    findings?: readonly Finding[];
    /** Runs the steps before this one, when the editor can. */
    onRunPrevious?: (() => void) | null;
}

/**
 * The first rows of what the step makes, after every change. It says how much
 * of the table it looked at, what it could not do in a preview, and, when a
 * setting is wrong, that the problem is shown next to the setting.
 */
export default function TablePreviewPane({ state, hasSource, upTo = '', findings = [], onRunPrevious = null }: Props) {
    const { t } = useTranslation();
    const tr = t as Translate;
    if (!hasSource) {
        return (
            <div className="flex flex-col items-start gap-1.5 rounded border border-dashed border-[var(--border-default)] p-3" data-testid="table-preview-empty">
                <p className={hintTextClass()}>{t('automation_tables.preview.no_source', 'Run the steps before this one once to see a preview.')}</p>
                {onRunPrevious && (
                    <button type="button" onClick={onRunPrevious} className="text-[11px] text-[var(--accent)] hover:underline">
                        {t('automation_tables.preview.run', 'Run them now')}
                    </button>
                )}
            </div>
        );
    }
    const res = state.response;
    const loading = state.status === 'loading';
    return (
        <section aria-label={t('automation_tables.preview.title', 'Preview')} aria-busy={loading} className="flex flex-col gap-2 rounded border border-[var(--border-default)] p-2" data-testid="table-preview">
            <header className="flex items-center gap-2 text-xs font-medium text-[var(--text-primary)]">
                <span>{upTo ? t('automation_tables.preview.title_upto', 'Preview after: {step}', { step: upTo }) : t('automation_tables.preview.title', 'Preview')}</span>
                {loading && <Loader2 size={12} className="animate-spin text-[var(--text-tertiary)]" aria-label={t('automation_tables.preview.updating', 'Updating the preview…')} />}
            </header>
            {state.error && <p role="alert" className="text-[11px] text-[var(--error)]">{state.error}</p>}
            {res && !res.ok && (
                <div className="flex flex-col gap-1" data-testid="table-preview-findings">
                    <p className="flex items-center gap-1 text-[11px] text-[var(--error)]"><AlertTriangle size={12} /> {t('automation_tables.preview.fix', 'There is no preview until this is fixed. The problem is shown next to the setting.')}</p>
                    <ul className="list-disc pl-4 text-[11px] text-[var(--text-secondary)]">
                        {[...res.findings, ...findings.filter(f => !res.findings.includes(f))].filter(f => f.severity === 'error').map((f, i) => <li key={`${f.code}-${i}`}>{f.message}</li>)}
                    </ul>
                </div>
            )}
            {res && res.ok && <PreviewResult res={res} tr={tr} />}
        </section>
    );
}
