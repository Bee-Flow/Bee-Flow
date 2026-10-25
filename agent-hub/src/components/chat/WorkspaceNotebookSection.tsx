import { SetStateAction, RefObject, Dispatch } from 'react';
import { TranslateParams } from '../../hooks/useTranslation';
import { X, ExternalLink, Download, FileDown, Loader2, ChevronDown, FileText } from 'lucide-react';

export function WorkspaceNotebookSection({ t, saving, user, exportMenuRef, setExportMenuOpen, exporting, exportMenuOpen, handleExport, handleOpenNotebook, flushSaveRef, onClose }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; saving: boolean; user: { featureFlags?: { export?: boolean; openInNotebook?: boolean; askAi?: boolean;[key: string]: boolean | undefined; }; } | null | undefined; exportMenuRef: RefObject<HTMLDivElement | null>; setExportMenuOpen: Dispatch<SetStateAction<boolean>>; exporting: string | null; exportMenuOpen: boolean; handleExport: (format: string) => Promise<void>; handleOpenNotebook: () => Promise<void>; flushSaveRef: RefObject<(() => void) | null>; onClose: (() => void) | undefined; }) {
    return <div
        className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]"
    >
        <div className="flex items-center gap-2">
            <span className="text-sm">📓</span>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                {t('notebooks.panel_title', 'Notebook')}
            </h3>
            {saving && (
                <span className="text-[10px] animate-pulse ml-1 text-[var(--accent-primary)]">
                    {t('notebooks.saving', 'Saving…')}
                </span>
            )}
        </div>

        <div className="flex items-center gap-0.5">

            {/* Export dropdown */}
            {user?.featureFlags?.export !== false && (
                <div className="relative" ref={exportMenuRef}>
                    <button
                        onClick={() => setExportMenuOpen(p => !p)}
                        disabled={!!exporting}
                        className="p-1.5 rounded-lg transition-colors hover:bg-[var(--bg-tertiary)] flex items-center gap-0.5"
                        style={{ color: exporting ? 'var(--accent-primary)' : 'var(--text-tertiary)' }}
                        title={t('notebooks.export_title')}
                    >
                        {exporting
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <Download className="w-3.5 h-3.5" />}
                        <ChevronDown className="w-2.5 h-2.5" />
                    </button>

                    {exportMenuOpen && (
                        <div
                            className="absolute right-0 top-full mt-1 rounded-xl border py-1 shadow-xl z-50 min-w-[150px] bg-[var(--bg-primary)] border-[var(--border-default)]"
                        >
                            <button
                                onClick={() => handleExport('pdf')}
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                            >
                                <FileDown className="w-3.5 h-3.5 text-red-500" />
                                {t('notebooks.export_pdf')}
                            </button>
                            <button
                                onClick={() => handleExport('docx')}
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                            >
                                <FileText className="w-3.5 h-3.5 text-blue-500" />
                                {t('notebooks.export_word')}
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* Open in full Notebook */}
            {user?.featureFlags?.openInNotebook !== false && (
                <button
                    onClick={handleOpenNotebook}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors hover:bg-[var(--bg-tertiary)] text-[var(--accent-primary)]"
                    title={t('notebooks.open_in_notebook_title')}
                >
                    <ExternalLink className="w-3 h-3" />
                    {t('notebooks.open_in_notebook')}
                </button>
            )}

            {/* Divider */}
            {(user?.featureFlags?.export !== false || user?.featureFlags?.openInNotebook !== false) && (
                <div className="w-px h-4 mx-1 bg-[var(--border-subtle)]" />
            )}

            {/* Close — flush first; closing is not unmounting everywhere. */}
            <button
                onClick={() => { flushSaveRef.current?.(); onClose?.(); } }
                className="p-1.5 rounded-lg transition-colors hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]"
                title={t('notebooks.close')}
            >
                <X className="w-4 h-4" />
            </button>
        </div>
    </div>;
}
