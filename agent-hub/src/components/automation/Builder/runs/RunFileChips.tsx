import React, { useMemo, useState } from 'react';
import { Download, Eye, FileImage, FileText } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { formatBytes } from '../../../../utils/dateFormatters';
import { downloadRunFile, generatedFilesOf, previewKindOf } from '../../../../api/queries/automation/runFiles';
import type { RunFileRef } from '../../../../api/queries/automation/runFiles';
import RunFilePreview from './RunFilePreview';

const CHIP_BTN = 'inline-flex items-center gap-1 px-2 py-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50';

function RunFileChip({ runId, file }: { runId: string; file: RunFileRef }) {
    const { t } = useTranslation();
    const [previewing, setPreviewing] = useState(false);
    const [failed, setFailed] = useState(false);
    const kind = previewKindOf(file.mime);
    const Icon = kind === 'image' ? FileImage : FileText;

    const download = async () => {
        setFailed(false);
        try {
            await downloadRunFile(runId, file.fileId, file.name);
        } catch {
            setFailed(true);
        }
    };

    return (
        <li className="min-w-0" data-testid="run-file-chip">
            <div className="flex items-center gap-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] pl-2.5 pr-1 py-1 min-w-0">
                <Icon size={14} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />
                <span className="min-w-0 truncate font-medium text-[var(--text-primary)]" title={file.name}>{file.name}</span>
                {file.size != null && <span className="shrink-0 pl-1 text-[var(--text-tertiary)]">{formatBytes(file.size)}</span>}
                <span className="ml-auto flex shrink-0 items-center pl-1">
                    {kind && (
                        <button type="button" className={CHIP_BTN} onClick={() => setPreviewing(true)} aria-label={t('runs.file.preview_named', 'Preview {name}', { name: file.name })}>
                            <Eye size={13} aria-hidden />
                            <span>{t('runs.file.preview', 'Preview')}</span>
                        </button>
                    )}
                    <button type="button" className={CHIP_BTN} onClick={download} aria-label={t('runs.file.download_named', 'Download {name}', { name: file.name })}>
                        <Download size={13} aria-hidden />
                        <span>{t('runs.file.download', 'Download')}</span>
                    </button>
                </span>
            </div>
            {failed && (
                <div role="alert" className="mt-1 px-1 text-[var(--error)]">
                    {t('runs.file.download_failed', 'Could not download this file. It may have expired.')}
                </div>
            )}
            {previewing && kind && <RunFilePreview runId={runId} file={file} kind={kind} onClose={() => setPreviewing(false)} />}
        </li>
    );
}

/**
 * The files a step kept, one compact chip each: name, size, Download, and
 * Preview for a PDF or an image. Nothing renders for a step that kept none.
 */
export default function RunFileChips({ runId, output }: { runId: string | null | undefined; output: unknown }) {
    const { t } = useTranslation();
    const files = useMemo(() => generatedFilesOf(output), [output]);
    if (!runId || !files.length) return null;
    return (
        <ul aria-label={t('runs.file.section', 'Files from this step')} className="flex flex-col gap-1.5 text-xs shrink-0">
            {files.map((f) => <RunFileChip key={f.fileId} runId={runId} file={f} />)}
        </ul>
    );
}
