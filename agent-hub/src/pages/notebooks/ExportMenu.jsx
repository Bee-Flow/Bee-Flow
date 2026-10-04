/**
 * ExportMenu — the document export action cluster for the workspace header:
 * PDF / Word dropdown + optional SignRequest and Nextcloud buttons. Sits in
 * the Studio header's action slot (NotebookWorkspace). Closes on an outside
 * press and on Escape.
 */
import React, { useState, useRef, useEffect } from 'react';
import { Download, FileDown, Loader2, ChevronDown, PenTool, FileType2 } from 'lucide-react';
import useTranslation from '../../hooks/useTranslation';

export default function ExportMenu({
    onExport,
    exporting,
    hasContent = true,
    signRequestConfigured = false,
    onSignRequest,
    nextcloudConfigured = false,
    onNextcloudExport,
    nextcloudExporting = false,
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const ref = useRef(null);

    useEffect(() => {
        const handleOutside = (e) => {
            if (ref.current && !ref.current.contains(e.target)) setOpen(false);
        };
        const handleKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', handleOutside);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleOutside);
            document.removeEventListener('keydown', handleKey);
        };
    }, []);

    const isExporting = !!exporting;
    const select = (format) => { setOpen(false); onExport?.(format); };

    return (
        <div className="flex items-center gap-1">
            <div className="relative" ref={ref}>
                <button
                    type="button"
                    disabled={!hasContent || isExporting}
                    onClick={() => setOpen((p) => !p)}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    className="flex items-center gap-1.5 h-8 px-2 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-40 transition-colors"
                    title={t('notebooks.export', 'Export')}
                >
                    {isExporting
                        ? <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-primary)]" aria-hidden="true" />
                        : <Download className="w-4 h-4" aria-hidden="true" />}
                    <span className="text-[13px] font-medium">{t('notebooks.export', 'Export')}</span>
                    <ChevronDown className={`w-3 h-3 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
                </button>

                {open && hasContent && (
                    <div
                        role="menu"
                        aria-label={t('notebooks.export', 'Export')}
                        className="absolute top-full right-0 mt-1 w-52 rounded-xl shadow-xl border overflow-hidden z-50 text-left bg-[var(--bg-primary)] border-[var(--border-default)]"
                    >
                        <div className="p-1">
                            <button
                                type="button"
                                role="menuitem"
                                disabled={isExporting}
                                onClick={() => select('pdf')}
                                className="w-full text-left px-3 py-2 rounded-lg hover:bg-[var(--bg-tertiary)] flex items-center gap-3 disabled:opacity-50 transition-colors"
                            >
                                <div className="p-1 rounded-md text-[var(--error)] bg-[color-mix(in_srgb,var(--error)_12%,transparent)]">
                                    {exporting === 'pdf' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <FileDown className="w-4 h-4" aria-hidden="true" />}
                                </div>
                                <div className="text-sm font-medium text-[var(--text-primary)]">{t('notebooks.download_pdf', 'Download as PDF')}</div>
                            </button>
                            <button
                                type="button"
                                role="menuitem"
                                disabled={isExporting}
                                onClick={() => select('docx')}
                                className="w-full text-left px-3 py-2 rounded-lg hover:bg-[var(--bg-tertiary)] flex items-center gap-3 disabled:opacity-50 transition-colors"
                            >
                                <div className="p-1 rounded-md text-[var(--info)] bg-[color-mix(in_srgb,var(--info)_12%,transparent)]">
                                    {exporting === 'docx' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <FileType2 className="w-4 h-4" aria-hidden="true" />}
                                </div>
                                <div className="text-sm font-medium text-[var(--text-primary)]">{t('notebooks.download_word', 'Download as Word')}</div>
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {signRequestConfigured && (
                <button
                    type="button"
                    disabled={!hasContent || isExporting}
                    onClick={onSignRequest}
                    className="grid place-items-center w-8 h-8 rounded-lg hover:bg-[var(--bg-tertiary)] disabled:opacity-40 transition-colors"
                    title={t('notebooks.send_for_signing', 'Send for signing')}
                    aria-label={t('notebooks.send_for_signing', 'Send for signing')}
                >
                    <PenTool className="w-4 h-4 text-[var(--success)]" aria-hidden="true" />
                </button>
            )}
            {nextcloudConfigured && (
                <button
                    type="button"
                    disabled={!hasContent || isExporting || nextcloudExporting}
                    onClick={onNextcloudExport}
                    className="grid place-items-center w-8 h-8 rounded-lg hover:bg-[var(--bg-tertiary)] disabled:opacity-40 transition-colors"
                    title={t('notebooks.export_nextcloud', 'Save to Nextcloud')}
                    aria-label={t('notebooks.export_nextcloud', 'Save to Nextcloud')}
                >
                    {nextcloudExporting
                        ? <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-primary)]" aria-hidden="true" />
                        : <svg viewBox="0 0 32 32" fill="none" className="w-4 h-4" aria-hidden="true"><path d="M11.5 11.2c-2 0-3.7 1.4-4.2 3.3a3.5 3.5 0 1 0 0 3 4.4 4.4 0 0 0 7 1.7l1.5-1.4 1.6 1.4a4.4 4.4 0 0 0 7-1.7 3.5 3.5 0 1 0 0-3 4.4 4.4 0 0 0-7-1.7l-1.6 1.4-1.5-1.4a4.4 4.4 0 0 0-2.8-1.6zm0 2.2a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8zm9 0a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8z" fill="#0082C9" /></svg>
                    }
                </button>
            )}
        </div>
    );
}
