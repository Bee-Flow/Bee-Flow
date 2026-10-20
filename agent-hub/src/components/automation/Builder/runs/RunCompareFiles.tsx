import React from 'react';
import { FileText } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { FileCompare } from '../../../../api/queries/automation/runChecks';
import { formatBytes, partChanges } from './runCompareText';

function changeText(t: TranslateFn, change: FileCompare['change']): string {
    switch (change) {
        case 'same': return t('automation_run_checks.file.same', 'Same content');
        case 'added': return t('automation_run_checks.file.added', 'Only in run B');
        case 'removed': return t('automation_run_checks.file.removed', 'Only in run A');
        default: return t('automation_run_checks.file.changed', 'Content changed');
    }
}

/** "application/pdf · 2.0 KB", or the size on each side when it moved. */
function typeAndSize(file: FileCompare): string {
    const shown = file.b ?? file.a;
    const moved = !!file.a && !!file.b && file.a.size !== file.b.size;
    const size = moved ? `${formatBytes(file.a?.size ?? null)} → ${formatBytes(file.b?.size ?? null)}` : formatBytes(shown?.size ?? null);
    return [shown?.mime, size].filter(Boolean).join(' · ');
}

/** One kept file of one step: name, type and size, then per slide or sheet what changed. */
function FileRow({ file }: { file: FileCompare }) {
    const { t } = useTranslation();
    const parts = file.change === 'changed' ? partChanges(t, file.a, file.b) : [];
    return (
        <li className="rounded-md border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <FileText size={13} aria-hidden className="text-[var(--text-tertiary)] shrink-0" />
                <span className="font-medium text-[var(--text-primary)] break-all">{(file.b ?? file.a)?.name}</span>
                <span className="text-[var(--text-tertiary)]">{typeAndSize(file)}</span>
                <span className="ml-auto text-[var(--text-secondary)]">{changeText(t, file.change)}</span>
            </div>
            {parts.length > 0 && (
                <ul className="mt-1.5 flex flex-col gap-1">
                    {parts.map(p => (
                        <li key={p.key} className="text-[var(--text-secondary)]">
                            <span className="font-medium text-[var(--text-primary)]">{p.label}</span>
                            {p.status === 'added' && <span>: {t('automation_run_checks.part.added', 'added')}</span>}
                            {p.status === 'removed' && <span>: {t('automation_run_checks.part.removed', 'removed')}</span>}
                            {p.details.map(d => (
                                <span key={d.field} className="ml-2">
                                    {d.field}: <span className="text-[var(--text-tertiary)]">{d.was}</span> → {d.becomes}
                                </span>
                            ))}
                        </li>
                    ))}
                </ul>
            )}
        </li>
    );
}

/** The files a step kept in the two runs, as the compare paired them. */
export default function RunCompareFiles({ files }: { files: FileCompare[] }) {
    const { t } = useTranslation();
    if (!files.length) return null;
    return (
        <div>
            <h4 className="mb-1 font-medium text-[var(--text-secondary)]">{t('automation_run_checks.file.heading', 'Files')}</h4>
            <ul className="flex flex-col gap-1.5">
                {files.map((f, i) => <FileRow key={`${f.stepId}-${i}`} file={f} />)}
            </ul>
        </div>
    );
}
