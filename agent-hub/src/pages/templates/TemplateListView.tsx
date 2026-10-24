import { ArrowLeft, FileText, Loader2, Plus, Search } from 'lucide-react';
import React from 'react';
import type { ChangeEvent, DragEvent, ReactNode, RefObject } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import TemplateCard from './TemplateCard';
import type { TemplateCardProps as CardProps } from './TemplateCard';
import type { TemplateRecord } from './templateTypes';

interface ListHeaderProps {
    onBack: () => void;
    searchQuery: string;
    setSearchQuery: (value: string) => void;
    uploading: boolean;
    skipAiDetection: boolean;
    setSkipAiDetection: (value: boolean) => void;
    fileInputRef: RefObject<HTMLInputElement | null>;
    handleUpload: (file: File) => void;
}

function ListHeader({ onBack, searchQuery, setSearchQuery, uploading, skipAiDetection, setSkipAiDetection, fileInputRef, handleUpload }: ListHeaderProps) {
    const { t } = useTranslation();
    return (
        <div className="shrink-0 px-6 py-4 border-b flex items-center gap-4 border-[var(--border-subtle)]">
            <button onClick={onBack} className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors">
                <ArrowLeft className="w-5 h-5 text-[var(--text-secondary)]" />
            </button>
            <div className="flex-1">
                <h1 className="text-lg font-bold text-[var(--text-primary)]">{t('templates.word_templates', 'Word Templates')}</h1>
                <p className="text-xs text-[var(--text-muted)]">{t('templates.upload_hint_before', 'Upload .docx templates with')} {'{{parameters}}'} {t('templates.upload_hint_after', 'for AI to fill')}</p>
            </div>
            <div className="flex items-center gap-2">
                {/* Search */}
                <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        placeholder={t('templates.search_templates', 'Search templates...')}
                        className="pl-8 pr-3 py-1.5 text-sm rounded-lg border w-48 focus:outline-none focus:ring-1"
                        style={{ borderColor: 'var(--border-default)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' } as React.CSSProperties}
                    />
                </div>
                {/* Upload button */}
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                        className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all hover:scale-[1.02] [background:linear-gradient(135deg,#6366f1,#8b5cf6)]"
                    >
                        {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                        {t('templates.upload_template', 'Upload Template')}
                    </button>
                    <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none text-[var(--text-secondary)]">
                        <input
                            type="checkbox"
                            checked={skipAiDetection}
                            onChange={e => setSkipAiDetection(e.target.checked)}
                            className="w-3.5 h-3.5 rounded accent-[#6366f1]"
                        />
                        {t('templates.skip_ai_detection', 'Skip AI detection')}
                    </label>
                </div>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".docx"
                    className="hidden"
                    onChange={e => {
                        const picked = e.target.files?.[0];
                        if (picked) handleUpload(picked);
                        e.target.value = '';
                    }}
                />
            </div>
        </div>
    );
}

interface ListContentProps extends Omit<CardProps, 'template'> {
    loading: boolean;
    templates: TemplateRecord[];
    searchQuery: string;
    dragOver: boolean;
    setDragOver: (value: boolean) => void;
    fileInputRef: RefObject<HTMLInputElement | null>;
    handleUpload: (file: File) => void;
}

function ListContent({ loading, templates, searchQuery, dragOver, setDragOver, fileInputRef, handleUpload, renamingId, setRenamingId, renameValue, setRenameValue, handleRename, deletingId, handleDelete, handleDownload, setFillTemplate, confirm }: ListContentProps) {
    const { t } = useTranslation();
    // Filter templates
    const filtered = templates.filter(t =>
        !searchQuery || t.name?.toLowerCase().includes(searchQuery.toLowerCase()) || t.fileName?.toLowerCase().includes(searchQuery.toLowerCase())
    );
    return (
        <div
            className={`flex-1 overflow-auto p-6 ${dragOver ? 'ring-2 ring-inset ring-[var(--accent-primary)]' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files[0]) handleUpload(e.dataTransfer.files[0]); }}
        >
            {loading ? (
                <div className="flex items-center justify-center h-full">
                    <Loader2 className="w-8 h-8 animate-spin text-[var(--text-muted)]" />
                </div>
            ) : filtered.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                    <div className="text-center">
                        <div className="w-20 h-20 mx-auto mb-4 rounded-2xl flex items-center justify-center [background:rgba(99,102,241,0.08)]">
                            <FileText className="w-10 h-10" style={{ color: '#6366f1', opacity: 0.6 }} />
                        </div>
                        <h3 className="text-base font-semibold mb-1 text-[var(--text-primary)]">
                            {searchQuery ? 'No templates found' : 'No templates yet'}
                        </h3>
                        <p className="text-sm mb-4 text-[var(--text-muted)]">
                            {searchQuery ? 'Try a different search' : 'Upload a .docx file with {{parameter}} placeholders'}
                        </p>
                        {!searchQuery && (
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white [background:linear-gradient(135deg,#6366f1,#8b5cf6)]"
                            >
                                {t('templates.upload_first', 'Upload Your First Template')}
                            </button>
                        )}
                    </div>
                </div>
            ) : (
                <div className="max-w-4xl mx-auto grid gap-3">
                    {filtered.map(template => (
                        <TemplateCard
                            key={template.id}
                            template={template}
                            renamingId={renamingId}
                            setRenamingId={setRenamingId}
                            renameValue={renameValue}
                            setRenameValue={setRenameValue}
                            handleRename={handleRename}
                            deletingId={deletingId}
                            handleDelete={handleDelete}
                            handleDownload={handleDownload}
                            setFillTemplate={setFillTemplate}
                            confirm={confirm}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

export interface TemplateListViewProps extends ListHeaderProps, Omit<ListContentProps, 'handleUpload' | 'fileInputRef'> {
    confirmDialog: ReactNode;
}

/** The template list: header with search and upload, the cards, and the delete confirmation. */
export default function TemplateListView(props: TemplateListViewProps) {
    const { confirmDialog, ...rest } = props;
    return (
        <div className="h-full flex flex-col bg-[var(--bg-primary)]">
            <ListHeader {...rest} />
            <ListContent {...rest} />
            {confirmDialog}
        </div>
    );
}
