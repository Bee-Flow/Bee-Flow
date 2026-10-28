import { AlertCircle, FileJson, Loader2, Plus, Upload } from 'lucide-react';
import React, { useRef } from 'react';
import { accentTile, CARD_STYLE } from './cardStyle';
import { importMetaLine, importProvenanceText } from './importExport';
import type { FilePreview } from './types';
import useTranslation from '@/hooks/useTranslation';

// ── Import from a file (inside the New-app modal) ───────────────────

/** No file picked yet — the drop-in prompt and the hidden file input. */
type PickHandler = (event: React.ChangeEvent<HTMLInputElement>) => void;

interface ImportPreviewProps {
    file: File | null;
    preview: FilePreview;
    error: string | null;
    importing: boolean;
    onClear: () => void;
    onImport: () => void;
}

interface ImportPanelProps extends Omit<ImportPreviewProps, 'preview'> {
    preview: FilePreview | null;
    onPick: PickHandler;
}

function ImportPicker({ error, onPick }: { error: string | null; onPick: PickHandler }) {
    const { t } = useTranslation();
    const inputRef = useRef<HTMLInputElement>(null);
    return (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl" style={accentTile(null)}>
                <FileJson className="w-5 h-5" />
            </span>
            <div className="text-sm max-w-sm text-[var(--text-secondary)]">
                {t('app_studio.list.import_intro', "Bring a file from another Bee Flow. A template lands in your organisation's gallery to create apps from; an app archive lands as a working app, with its rows and documents already in it.")}
            </div>
            <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-1.5 border border-[var(--border-default)] text-[var(--text-secondary)]"
                data-testid="app-template-import-pick"
            >
                <Upload className="w-3.5 h-3.5" />
                {t('app_studio.list.import_choose_file', 'Choose a file')}
            </button>
            <input
                ref={inputRef}
                type="file"
                accept="application/json,.json"
                onChange={onPick}
                className="hidden"
                aria-hidden="true"
                data-testid="app-template-import-input"
            />
            {error ? (
                <p className="flex items-start gap-1.5 text-xs max-w-sm text-left text-[var(--error)]">
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <span>{error}</span>
                </p>
            ) : null}
        </div>
    );
}

/** A file is in hand — what it claims, and the confirm/clear actions. */
function ImportPreview({ file, preview, error, importing, onClear, onImport }: ImportPreviewProps) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-3">
            <div className="rounded-xl border p-3" style={CARD_STYLE}>
                <div className="flex items-start gap-2.5">
                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg shrink-0" style={accentTile(null)}>
                        <FileJson className="w-4 h-4" />
                    </span>
                    <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold truncate text-[var(--text-primary)]">
                            {preview.title}
                        </div>
                        {preview.description ? (
                            <div className="text-xs line-clamp-2 mt-0.5 text-[var(--text-secondary)]">
                                {preview.description}
                            </div>
                        ) : null}
                        <div className="text-[11px] mt-1.5 text-[var(--text-tertiary)]">
                            {importMetaLine(preview, file, t)}
                        </div>
                    </div>
                </div>
            </div>

            <p className="text-[11px] text-[var(--text-tertiary)]">
                {importProvenanceText(preview, t)}
            </p>

            {error ? (
                <p className="flex items-start gap-1.5 text-xs text-[var(--error)]" role="alert">
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <span>{error}</span>
                </p>
            ) : null}

            <div className="flex items-center justify-between gap-2">
                <button
                    type="button"
                    onClick={onClear}
                    disabled={importing}
                    className="px-2.5 py-1.5 rounded-md text-xs font-medium disabled:opacity-60 text-[var(--text-tertiary)]"
                >
                    {t('app_studio.list.import_choose_another', 'Choose another file')}
                </button>
                <button
                    type="button"
                    onClick={onImport}
                    disabled={importing}
                    aria-busy={importing}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-white flex items-center gap-1.5 disabled:opacity-50 bg-[var(--accent-primary)]"
                    data-testid="app-template-import-confirm"
                >
                    {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                    {preview.kind === 'app' ? t('studio_apps_bi.list.import_create_app', 'Create the app') : t('studio_apps_bi.list.import_add_gallery', 'Add to gallery')}
                </button>
            </div>
        </div>
    );
}

function ImportPanel({ file, preview, error, importing, onPick, onClear, onImport }: ImportPanelProps) {
    return preview
        ? <ImportPreview file={file} preview={preview} error={error} importing={importing} onClear={onClear} onImport={onImport} />
        : <ImportPicker error={error} onPick={onPick} />;
}

export default ImportPanel;
