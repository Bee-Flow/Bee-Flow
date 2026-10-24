import { Check, Download, File, Loader2, Pencil, Trash2, X } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { formatRelativeTime } from '../../utils/dateFormatters';
import { getParam } from './templateTypes';
import type { TemplateRecord } from './templateTypes';

export interface TemplateCardProps {
    template: TemplateRecord;
    renamingId: string | null;
    setRenamingId: (id: string | null) => void;
    renameValue: string;
    setRenameValue: (value: string) => void;
    handleRename: (id: string) => void;
    deletingId: string | null;
    handleDelete: (id: string) => void;
    handleDownload: (template: TemplateRecord) => void;
    setFillTemplate: (template: TemplateRecord) => void;
    confirm: (opts: { title: string; confirmLabel: string; destructive: boolean }) => Promise<boolean>;
}

export default function TemplateCard({ template, renamingId, setRenamingId, renameValue, setRenameValue, handleRename, deletingId, handleDelete, handleDownload, setFillTemplate, confirm }: TemplateCardProps) {
    const { t } = useTranslation();
    return (
        <div
            className="group rounded-xl border p-4 transition-all hover:shadow-md hover:border-[var(--accent-primary)]/30 [border-color:var(--border-subtle)]! [background:var(--bg-secondary)]"
        >
            <div className="flex items-start gap-3">
                {/* Icon */}
                <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 [background:rgba(99,102,241,0.08)]">
                    <File className="w-5 h-5 [color:#6366f1]" />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                    {renamingId === template.id ? (
                        <div className="flex items-center gap-1.5">
                            <input
                                autoFocus
                                value={renameValue}
                                onChange={e => setRenameValue(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') handleRename(template.id); if (e.key === 'Escape') setRenamingId(null); }}
                                className="text-sm font-semibold px-2 py-0.5 rounded border focus:outline-none focus:ring-1"
                                style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)', background: 'var(--bg-primary)', '--tw-ring-color': 'var(--accent-primary)' } as React.CSSProperties}
                            />
                            <button onClick={() => handleRename(template.id)} className="p-0.5 rounded hover:bg-green-500/10"><Check className="w-4 h-4 text-green-500" /></button>
                            <button onClick={() => setRenamingId(null)} className="p-0.5 rounded hover:bg-red-500/10"><X className="w-4 h-4 text-red-400" /></button>
                        </div>
                    ) : (
                        <h3 className="text-sm font-semibold truncate text-[var(--text-primary)]">{template.name}</h3>
                    )}
                    <div className="flex items-center gap-3 mt-1">
                        <span className="text-[11px] text-[var(--text-muted)]">{template.fileName}</span>
                        <span className="text-[11px] text-[var(--text-muted)]">·</span>
                        <span className="text-[11px] text-[var(--text-muted)]">{formatRelativeTime(template.createdAt)}</span>
                    </div>
                    {template.parameters.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                            {template.parameters.slice(0, 8).map((p, i) => {
                                const param = getParam(p);
                                return (
                                    <span key={i} className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border-default)] text-[var(--text-muted)]" title={param.description || undefined}>
                                        {param.name}
                                    </span>
                                );
                            })}
                            {template.parameters.length > 8 && (
                                <span className="text-[10px] px-1.5 py-0.5 text-[var(--text-muted)]">{t('templates.more_parameters', '+{count} more', { count: template.parameters.length - 8 })}</span>
                            )}
                        </div>
                    )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                        onClick={() => setFillTemplate(template)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-all hover:scale-[1.02] [background:linear-gradient(135deg,#6366f1,#8b5cf6)]"
                    >
                        {t('templates.fill_with_ai', 'Fill with AI')}
                    </button>
                    <button
                        onClick={() => handleDownload(template)}
                        className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
                        title={t('templates.download', 'Download')}
                    >
                        <Download className="w-4 h-4 text-[var(--text-muted)]" />
                    </button>
                    <button
                        onClick={() => { setRenamingId(template.id); setRenameValue(template.name ?? ''); }}
                        className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
                        title={t('templates.rename', 'Rename')}
                    >
                        <Pencil className="w-4 h-4 text-[var(--text-muted)]" />
                    </button>
                    <button
                        onClick={async () => { if (await confirm({ title: 'Delete this template?', confirmLabel: 'Delete', destructive: true })) handleDelete(template.id); }}
                        disabled={deletingId === template.id}
                        className="p-1.5 rounded-lg hover:bg-red-500/10 transition-colors"
                        title={t('common.delete', 'Delete')}
                    >
                        {deletingId === template.id
                            ? <Loader2 className="w-4 h-4 animate-spin text-red-400" />
                            : <Trash2 className="w-4 h-4 text-red-400" />
                        }
                    </button>
                </div>
            </div>
        </div>
    );
}
