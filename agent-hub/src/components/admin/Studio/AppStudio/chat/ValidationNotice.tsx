import { Wrench } from 'lucide-react';
import useTranslation from '../../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../../hooks/useTranslation';

/** One validation record: a bare string, or the validator's object. */
type IssueRecord = string | { hint?: unknown; message?: unknown; code?: unknown; nodeId?: unknown } | null | undefined;

export interface IssueGroup {
    text: string;
    detail: string;
    count: number;
    /** The first record of the group — the one the Fix button acts on. */
    rec: IssueRecord;
}

/**
 * What a validation record says to a person, and what it says to a developer.
 * The record's `hint` is the plain-English line ("Pick one the app owner has.")
 * while `message` is validator wording ('A filter value must be a literal…') —
 * so `hint` leads and `message` becomes the technical detail behind a
 * disclosure. A bare `code` is never a headline; it means nothing to the reader.
 */
function issueLines(rec: IssueRecord, t: TranslateFn | null | undefined): { text: string; detail: string } {
    if (typeof rec === 'string') return { text: rec, detail: '' };
    const hint = typeof rec?.hint === 'string' ? rec.hint : '';
    const message = typeof rec?.message === 'string' ? rec.message : '';
    if (hint) return { text: hint, detail: message };
    if (message) return { text: message, detail: '' };
    return { text: t ? t('studio_apps_edit.chat.issue_fallback', 'Something here needs attention') : 'Something here needs attention', detail: typeof rec?.code === 'string' ? rec.code : '' };
}

function issueNodeId(rec: IssueRecord): string | null {
    return (rec && typeof rec === 'object' && typeof rec.nodeId === 'string') ? rec.nodeId : null;
}

/**
 * The records grouped by what they SAY. Four relation inputs on one missing
 * table are one line with ×4 (2026-09-13: the same sentence four times, then
 * "+20 more"), never four lines. The first record of a group is the one the
 * Fix button acts on.
 */
export function groupIssues(records: unknown, t?: TranslateFn | null): IssueGroup[] {
    const groups = new Map<string, IssueGroup>();
    for (const rec of (Array.isArray(records) ? records : []) as IssueRecord[]) {
        const { text, detail } = issueLines(rec, t);
        const key = `${text}\u0000${detail}`;
        const g = groups.get(key);
        if (g) g.count += 1;
        else groups.set(key, { text, detail, count: 1, rec });
    }
    return [...groups.values()];
}

interface ValidationNoticeProps {
    validation: { errors?: unknown; warnings?: unknown } | null | undefined;
    running: boolean;
    onFix: ((message: string, nodeId: string | null) => void) | null;
    disabled?: boolean;
}

function IssueRow({ g, running, onFix, disabled }: { g: IssueGroup; running: boolean; onFix: ValidationNoticeProps['onFix']; disabled: boolean }) {
    const { t } = useTranslation();
    return (
        <li className="flex flex-col gap-0.5 text-[11px] text-amber-700/90 dark:text-amber-400/90">
            <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate" title={g.text}>{g.text}</span>
                {g.count > 1 && (
                    <span className="shrink-0 tabular-nums opacity-80" data-testid="app-issue-count" title={t('app_studio.builder.validation.times', '{n} places', { n: g.count })}>×{g.count}</span>
                )}
                {!running && onFix ? (
                    <button
                        type="button"
                        disabled={disabled}
                        onClick={() => onFix(g.detail || g.text, issueNodeId(g.rec))}
                        className="inline-flex shrink-0 items-center gap-1 rounded border border-amber-500/40 px-1.5 py-0.5 font-medium text-amber-700 hover:bg-amber-500/15 disabled:opacity-40 dark:text-amber-300"
                    >
                        <Wrench className="h-3 w-3" aria-hidden="true" />
                        {t('app_studio.builder.validation.fix', 'Fix')}
                    </button>
                ) : null}
            </div>
            {g.detail ? (
                <details>
                    <summary className="cursor-pointer text-[11px] opacity-70">{t('app_studio.builder.validation.technical_detail', 'Technical detail')}</summary>
                    <span className="text-[11px] opacity-80">{g.detail}</span>
                </details>
            ) : null}
        </li>
    );
}

/**
 * Compact amber list of the latest validation records. While the stream is
 * running the AI is actively repairing them, so lead with that; otherwise each
 * issue gets a per-issue "Fix" button that asks the AI to repair just that one
 * (scoped to its node when the record carries a nodeId).
 */
export default function ValidationNotice({ validation, running, onFix, disabled = false }: ValidationNoticeProps) {
    const { t } = useTranslation();
    const errors: unknown[] = Array.isArray(validation?.errors) ? validation.errors : [];
    const warnings: unknown[] = Array.isArray(validation?.warnings) ? validation.warnings : [];
    if (!errors.length && !warnings.length) return null;

    const groups = groupIssues([...errors, ...warnings], t);
    const shown = groups.slice(0, 4);
    const n = errors.length;

    return (
        <div className="shrink-0 border-t border-amber-500/30 bg-amber-500/10 px-3 py-2">
            {n > 0 && (
                <div className="text-xs font-medium text-amber-700 dark:text-amber-400">
                    {running
                        ? (n === 1 ? t('app_studio.builder.validation.fixing_one', 'The AI is fixing 1 issue…') : t('app_studio.builder.validation.fixing', 'The AI is fixing {n} issues…', { n }))
                        : (n === 1 ? t('app_studio.builder.validation.to_review_one', '1 issue to review') : t('app_studio.builder.validation.to_review', '{n} issues to review', { n }))}
                </div>
            )}
            <ul className="mt-1 flex flex-col gap-0.5">
                {shown.map((g, i) => (
                    <IssueRow key={i} g={g} running={running} onFix={onFix} disabled={disabled} />
                ))}
                {groups.length > shown.length && (
                    <li className="text-[11px] text-amber-700/70 dark:text-amber-400/70">
                        {t('app_studio.builder.validation.more', '+{n} more', { n: groups.length - shown.length })}
                    </li>
                )}
            </ul>
        </div>
    );
}
