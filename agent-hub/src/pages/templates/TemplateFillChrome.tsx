import { ArrowLeft, Download, Loader2, MessageSquare, Settings } from 'lucide-react';
import React from 'react';
import MeetingPicker from '../../components/meeting-picker/MeetingPicker';
import { useTranslation } from '../../hooks/useTranslation';
import { getParam } from './templateTypes';
import type { TemplateRecord } from './templateTypes';

export interface FillHeaderProps {
    fillTemplate: TemplateRecord;
    parameterizing: boolean;
    showSettings: boolean;
    setShowSettings: (show: boolean) => void;
    generating: boolean;
    hasMessages: boolean;
    onClose: () => void;
    onGenerate: () => void;
}

export function FillHeader({ fillTemplate, parameterizing, showSettings, setShowSettings, generating, hasMessages, onClose, onGenerate }: FillHeaderProps) {
    const { t } = useTranslation();
    return (
        <div className="shrink-0 px-6 py-4 border-b flex items-center gap-3 border-[var(--border-subtle)]">
            <button onClick={() => onClose()} className="p-1 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors">
                <ArrowLeft className="w-5 h-5 text-[var(--text-secondary)]" />
            </button>
            <div className="flex-1 min-w-0">
                <h2 className="text-base font-semibold truncate text-[var(--text-primary)]">
                    {fillTemplate.name}
                </h2>
                <p className="text-xs flex items-center gap-1.5 text-[var(--text-muted)]">
                    {parameterizing ? (
                        <><span className="w-3 h-3 border-2 border-t-transparent rounded-full animate-spin inline-block [border-color:var(--accent-primary)]! [border-top-color:transparent]!" /> {t('templates.detecting_parameters', 'Detecting parameters...')}</>
                    ) : (
                        <>{fillTemplate.parameters.length !== 1 ? t('templates.parameter_count_plural', '{count} parameters', { count: fillTemplate.parameters.length }) : t('templates.parameter_count', '{count} parameter', { count: fillTemplate.parameters.length })} · {fillTemplate.fileName}</>
                    )}
                </p>
            </div>

            {/* Tab Switcher */}
            <div className="flex gap-1 p-0.5 rounded-lg [background:var(--bg-secondary)] [border:1px_solid_var(--border-subtle)]">
                <button
                    onClick={() => setShowSettings(false)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${!showSettings ? 'bg-[var(--accent-primary)] text-white shadow-sm' : 'text-[var(--text-secondary)]'}`}
                >
                    <MessageSquare className="w-3.5 h-3.5" /> {t('templates.tab_chat', 'Chat')}
                </button>
                <button
                    onClick={() => setShowSettings(true)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${showSettings ? 'bg-[var(--accent-primary)] text-white shadow-sm' : 'text-[var(--text-secondary)]'}`}
                >
                    <Settings className="w-3.5 h-3.5" /> {t('templates.tab_settings_knowledge', 'Settings & Knowledge')}
                </button>
            </div>

            <button
                onClick={onGenerate}
                disabled={generating || !hasMessages}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-40"
                style={{ background: generating ? 'var(--text-muted)' : 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
            >
                {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {generating ? 'Generating...' : 'Generate Document'}
            </button>
        </div>
    );
}

export interface FillSidebarProps {
    fillTemplate: TemplateRecord;
    parameterizing: boolean;
    selectedNoteIds: string[];
    setSelectedNoteIds: (ids: string[]) => void;
}

export function FillSidebar({ fillTemplate, parameterizing, selectedNoteIds, setSelectedNoteIds }: FillSidebarProps) {
    const { t } = useTranslation();
    return (
        <div className="w-[200px] xl:w-[280px] shrink-0 border-r overflow-auto p-4 flex flex-col gap-4 border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
            {/* Parameters */}
            <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider mb-2 text-[var(--text-muted)]">{t('templates.parameters', 'Parameters')}</h3>
                <div className="flex flex-wrap gap-1.5">
                    {fillTemplate.parameters.map((p, i) => {
                        const param = getParam(p);
                        return (
                            <span key={i} className="text-xs px-2 py-1 rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] bg-[var(--bg-primary)]" title={param.description || undefined}>
                                {param.description ? `${param.name}: ${param.description}` : `{{${param.name}}}`}
                            </span>
                        );
                    })}
                    {fillTemplate.parameters.length === 0 && (
                        parameterizing ? (
                            <div className="flex items-center gap-2 py-2">
                                <div className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin [border-color:var(--accent-primary)]! [border-top-color:transparent]!" />
                                <p className="text-xs text-[var(--text-secondary)]">{t('templates.analyzing_document', 'AI is analyzing the document and detecting parameters...')}</p>
                            </div>
                        ) : (
                            <p className="text-xs text-[var(--text-muted)]">{t('templates.no_parameters', 'No parameters detected in this template')}</p>
                        )
                    )}
                </div>
            </div>

            {/* Meeting Notes Context — shared MeetingPicker */}
            <div>
                <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{t('templates.meeting_notes_context', 'Meeting Notes Context')}</h3>
                    {selectedNoteIds.length > 0 && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full [background:color-mix(in_srgb,var(--accent-primary)_14%,transparent)] [color:var(--accent-primary)]!">
                            {t('templates.notes_selected', '{count} selected', { count: selectedNoteIds.length })}
                        </span>
                    )}
                </div>
                <MeetingPicker
                    mode="multi"
                    value={selectedNoteIds}
                    onChange={setSelectedNoteIds}
                    placeholder={t('templates.search_meeting_notes', 'Search meeting notes…')}
                />
            </div>

            {fillTemplate.description && (
                <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider mb-2 text-[var(--text-muted)]">{t('common.description', 'Description')}</h3>
                    <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{fillTemplate.description}</p>
                </div>
            )}
        </div>
    );
}
