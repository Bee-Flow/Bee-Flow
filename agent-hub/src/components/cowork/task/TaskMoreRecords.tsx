/**
 * The rows of More in an opened task (./CoworkTaskMore.tsx) about what is kept of it:
 *
 *   - Template and package file: save it as a template for the organisation, and download that template as a package
 *     file signed by this installation (server usecases/coworkTemplates.mts, usecases/coworkPackages.mts);
 *   - Receipts: whether the chain of run receipts holds, checked again on request, and the chain as a download;
 *   - Change history: who changed what and when, Cowork's own changes tagged "Cowork, automatic".
 */
import { useState } from 'react';
import { fullTimestamp } from '../coworkFormat';
import { trailLine } from '../coworkTrailModel';
import { BTN_QUIET, CARD_SOFT, FIELD, Failure, FoldRow, LABEL, META, ROW_ACTIONS, TAG_ACCENT, TAG_OK } from './taskUi';
import { packageUrl, useSaveCoworkTemplate } from '@/api/coworkTemplates';
import { receiptsUrl, useReceipts, type ReceiptsView } from '@/api/coworkReceipts';
import { useCoworkTrail } from '@/api/coworkTrail';
import type { TranslateFn } from '@/hooks/useTranslation';

interface RowProps { coworkId: string; open: boolean; onToggle: (id: string | null) => void; t: TranslateFn }

/** A file name from a title: "Weekly sales numbers" reads "weekly-sales-numbers". */
export function slugOf(title: string): string {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
}

function TemplateBody({ coworkId, title, t }: { coworkId: string; title: string; t: TranslateFn }) {
    const [name, setName] = useState(title);
    const save = useSaveCoworkTemplate(coworkId);
    const saved = save.data?.template ?? null;
    const trimmed = name.trim();
    const id = `cowork-task-template-${coworkId}`;
    return (
        <>
            <div className="flex flex-wrap items-end gap-2">
                <span className="flex-[1_1_220px] min-w-0 flex flex-col gap-1">
                    <label htmlFor={id} className={LABEL}>{t('cowork_task.template.label', 'Save as a template for your organisation')}</label>
                    <input id={id} type="text" className={FIELD} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
                </span>
                <button type="button" className={BTN_QUIET} disabled={!trimmed || save.isPending || saved?.title === trimmed} onClick={() => save.mutate(trimmed)}>
                    {saved?.title === trimmed ? t('cowork_task.template.saved_button', 'Saved') : t('cowork_task.template.save', 'Save as template')}
                </button>
            </div>
            {saved ? (
                <div className={CARD_SOFT} role="status" data-testid="cowork-task-package">
                    <span className="text-[15px]">{t('cowork_task.template.saved', "Saved. Colleagues find it under 'Start from a template'. Your data and memory are not part of it.")}</span>
                    {save.data?.warnings.map((w) => <span key={w} className={META}>{w}</span>)}
                    <span className={ROW_ACTIONS}>
                        <a className={BTN_QUIET} href={packageUrl(saved.id)} download={`${slugOf(saved.title)}.beeflow`}>{t('cowork_task.template.package', 'Export as a package file')}</a>
                        <span className={TAG_OK}>{t('cowork_task.template.signed', 'Signed')}</span>
                    </span>
                    <span className={META}>{t('cowork_task.template.package_hint', 'Whoever adds it sees that your organisation signed it and that nothing was changed since.')}</span>
                </div>
            ) : <p className={META}>{t('cowork_task.template.package_first', 'Save it as a template first; then you can export it as a signed package file.')}</p>}
            <Failure error={save.error} t={t} />
        </>
    );
}

export function TemplateRow({ coworkId, title, open, onToggle, t }: RowProps & { title: string }) {
    return (
        <FoldRow id="template" label={t('cowork_task.more.template', 'Template and package file')} open={open} onToggle={onToggle}>
            <TemplateBody coworkId={coworkId} title={title} t={t} />
        </FoldRow>
    );
}

const PROBLEMS: Record<string, [string, string]> = {
    gap: ['cowork_task.receipts.gap', 'Receipt {seq} is missing from the chain.'],
    link: ['cowork_task.receipts.link', 'Receipt {seq} does not follow the one before it.'],
    content: ['cowork_task.receipts.content', 'Receipt {seq} was changed after it was issued.'],
    signature: ['cowork_task.receipts.signature', 'Receipt {seq} does not carry a valid signature.'],
};

/** Whether the chain holds, in one line. */
export function chainWords(view: ReceiptsView | undefined, t: TranslateFn): string {
    if (!view || view.verdict.count === 0) return t('cowork_task.receipts.none', 'No receipts yet');
    const problem = view.verdict.problem;
    if (problem) {
        const [key, en] = PROBLEMS[problem.kind] ?? PROBLEMS.content;
        return t(key, en, { seq: problem.seq });
    }
    if (view.missingRuns > 0) return t('cowork_task.receipts.missing', '{count} finished runs have no receipt.', { count: view.missingRuns });
    return t('cowork_task.receipts.ok', 'All {count} receipts check out', { count: view.verdict.count });
}

function ReceiptsBody({ coworkId, t }: { coworkId: string; t: TranslateFn }) {
    const receipts = useReceipts(coworkId);
    const [checked, setChecked] = useState(false);
    const again = () => { receipts.refetch().then(() => setChecked(true)).catch(() => undefined); };
    return (
        <>
            <p className="text-[14px] text-[var(--success-ink)]" role="status">
                {receipts.isFetching ? t('cowork_task.receipts.checking', 'Checking the receipts…') : chainWords(receipts.data, t)}
                {checked && !receipts.isFetching ? ` ${t('cowork_task.receipts.just_now', '(checked just now)')}` : ''}
            </p>
            <p className={META}>{t('cowork_task.receipts.hint', 'Every run leaves a signed receipt: what ran, when, and what it changed or sent. If someone altered one later, this check would show it.')}</p>
            <div className={ROW_ACTIONS}>
                <button type="button" className={BTN_QUIET} disabled={receipts.isFetching} onClick={again}>{t('cowork_task.receipts.check', 'Check again')}</button>
                <a className={BTN_QUIET} href={receiptsUrl(coworkId)} download={`cowork-receipts-${coworkId}.json`}>{t('cowork_task.receipts.export', 'Export receipts')}</a>
            </div>
            <Failure error={receipts.error} t={t} />
        </>
    );
}

export function ReceiptsRow({ coworkId, open, onToggle, t }: RowProps) {
    const view = useReceipts(coworkId).data;
    return (
        <FoldRow id="receipts" label={t('cowork_task.more.receipts', 'Receipts')} value={chainWords(view, t)} open={open} onToggle={onToggle}>
            <ReceiptsBody coworkId={coworkId} t={t} />
        </FoldRow>
    );
}

function HistoryBody({ coworkId, t }: { coworkId: string; t: TranslateFn }) {
    const trail = useCoworkTrail(coworkId, true);
    const entries = trail.data ?? [];
    if (trail.isSuccess && entries.length === 0) return <p className={META}>{t('cowork_task.history.empty', 'No changes recorded yet.')}</p>;
    return (
        <>
            <ul className="list-none m-0 p-0">
                {entries.map((entry, i) => (
                    <li key={`${entry.action}-${entry.at ?? i}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 border-t first:border-t-0 border-[var(--border-subtle)] text-[14px]" data-testid="cowork-task-change">
                        <span className="basis-[96px] flex-shrink-0 tabular-nums text-[var(--text-tertiary)]">{entry.at ? fullTimestamp(entry.at, t) : ''}</span>
                        {entry.byCowork && <span className={TAG_ACCENT}>{t('cowork_task.history.cowork', 'Cowork, automatic')}</span>}
                        <span className="flex-1 basis-[200px] min-w-0 break-words">{trailLine(entry, t)}</span>
                    </li>
                ))}
            </ul>
            <Failure error={trail.error} t={t} />
        </>
    );
}

export function HistoryRow({ coworkId, open, onToggle, t }: RowProps) {
    return (
        <FoldRow id="history" label={t('cowork_task.more.history', 'Change history')} open={open} onToggle={onToggle}>
            <HistoryBody coworkId={coworkId} t={t} />
        </FoldRow>
    );
}
