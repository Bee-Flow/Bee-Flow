import { AlertCircle, Download, FileText, Globe, Languages, Mail, Plus, Star, Trash2, Upload, X } from 'lucide-react';
import { useState } from 'react';
import AddLanguageModal from './AddLanguageModal';
import EmailTemplateEditor from './EmailTemplateEditor';
import GuiStringEditor from './GuiStringEditor';
import PromptEditor from './PromptEditor';
import useLanguages from './useLanguages';
import type { LanguagesState } from './useLanguages';
import { useTranslation } from '@/hooks/useTranslation';

type Section = 'gui' | 'prompts' | 'emails';

type LocaleListProps = Pick<LanguagesState,
    'locales' | 'selectedLocale' | 'setSelectedLocale' | 'setShowAddModal'
    | 'handleSetDefault' | 'handleExport' | 'handleImport' | 'handleDeleteLocale'>;

/** Left: the installed locales, with per-locale actions on hover. */
function LocaleList({ locales, selectedLocale, setSelectedLocale, setShowAddModal, handleSetDefault, handleExport, handleImport, handleDeleteLocale }: LocaleListProps) {
    const { t } = useTranslation();
    return (
        <div className="w-64 border-r shrink-0 flex flex-col border-[var(--border-default)] bg-[var(--bg-secondary)]">
            <div className="p-3 border-b flex items-center justify-between border-[var(--border-default)]">
                <span className="text-sm font-semibold flex items-center gap-2 text-[var(--text-primary)]">
                    <Globe className="w-4 h-4 text-[var(--accent-primary)]" /> {t('admin_languages.title', 'Languages')}
                </span>
                <button onClick={() => setShowAddModal(true)} className="p-1 rounded-md transition-colors hover:bg-[var(--bg-tertiary)]" title={t('admin_languages.add_language_title', 'Add language')}>
                    <Plus className="w-4 h-4 text-[var(--text-secondary)]" />
                </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {locales.map(locale => {
                    const active = selectedLocale === locale.code;
                    return (
                        <div
                            key={locale.code}
                            onClick={() => setSelectedLocale(locale.code)}
                            className={`group px-3 py-2 rounded-lg cursor-pointer flex items-center justify-between transition-all ${active ? 'bg-[var(--accent-primary)] text-white' : 'hover:bg-[var(--bg-tertiary)]'}`}
                        >
                            <div className="flex items-center gap-2 min-w-0">
                                <span className="text-sm font-medium truncate">{locale.name}</span>
                                <span className="text-xs opacity-60">{locale.code}</span>
                                {locale.isDefault && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: active ? 'rgba(255,255,255,0.2)' : 'var(--accent-primary)', color: active ? '#fff' : '#fff' }}>
                                        {t('admin_languages.default', 'Default')}
                                    </span>
                                )}
                            </div>
                            {locale.code !== 'en' && (
                                <div className={`flex items-center gap-0.5 ${active ? 'opacity-80' : 'opacity-0 group-hover:opacity-60'} transition-opacity`}>
                                    {!locale.isDefault && (
                                        <button onClick={(e) => { e.stopPropagation(); handleSetDefault(locale.code); }} className="p-1 rounded hover:bg-black/10" title={t('admin_languages.set_default', 'Set as default')}>
                                            <Star className="w-3 h-3" />
                                        </button>
                                    )}
                                    <button onClick={(e) => { e.stopPropagation(); handleExport(locale.code); }} className="p-1 rounded hover:bg-black/10" title={t('admin_languages.export', 'Export')}><Download className="w-3 h-3" /></button>
                                    <button onClick={(e) => { e.stopPropagation(); handleImport(locale.code); }} className="p-1 rounded hover:bg-black/10" title={t('admin_languages.import', 'Import')}><Upload className="w-3 h-3" /></button>
                                    <button onClick={(e) => { e.stopPropagation(); handleDeleteLocale(locale.code); }} className="p-1 rounded hover:bg-red-500/20" title={t('admin_languages.delete', 'Delete')}><Trash2 className="w-3 h-3" /></button>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

interface LocaleEditorProps {
    locale: string;
    activeSection: Section;
    setActiveSection: (s: Section) => void;
    onExport: () => void;
    onImport: () => void;
}

/** Right: the section tabs and the selected section's editor. */
function LocaleEditor({ locale, activeSection, setActiveSection, onExport, onImport }: LocaleEditorProps) {
    const { t } = useTranslation();
    const sections = [
        { id: 'gui' as const, label: t('admin_languages.tab_gui', 'GUI Translations'), icon: Languages },
        { id: 'prompts' as const, label: t('admin_languages.tab_prompts', 'System Prompts'), icon: FileText },
        { id: 'emails' as const, label: t('admin_languages.tab_emails', 'Email Templates'), icon: Mail },
    ];
    return (
        <>
            {/* Section Tabs */}
            <div className="px-4 pt-3 pb-0 flex items-center gap-2 shrink-0">
                {sections.map(({ id, label, icon: Icon }) => (
                    <button
                        key={id}
                        onClick={() => setActiveSection(id)}
                        className={`px-3.5 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-all ${activeSection === id ? 'bg-[var(--accent-primary)] text-white shadow-sm' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}
                    >
                        <Icon className="w-4 h-4" /> {label}
                    </button>
                ))}
                <div className="ml-auto flex items-center gap-2">
                    <button onClick={onExport} className="px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border transition-colors hover:bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-secondary)]">
                        <Download className="w-3.5 h-3.5" /> {t('admin_languages.export', 'Export')}
                    </button>
                    <button onClick={onImport} className="px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border transition-colors hover:bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-secondary)]">
                        <Upload className="w-3.5 h-3.5" /> {t('admin_languages.import', 'Import')}
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-hidden">
                {activeSection === 'gui' && (
                    <GuiStringEditor locale={locale} key={`gui-${locale}`} />
                )}
                {activeSection === 'prompts' && (
                    <PromptEditor locale={locale} key={`prompts-${locale}`} />
                )}
                {activeSection === 'emails' && (
                    <EmailTemplateEditor locale={locale} key={`emails-${locale}`} />
                )}
            </div>
        </>
    );
}

/** Admin → Languages: installed locales and, per locale, the GUI strings, system prompts and email templates. */
const LanguagesPanel = () => {
    const { t } = useTranslation();
    const langs = useLanguages();
    const { locales, catalog, selectedLocale, loading, error, setError, showAddModal, setShowAddModal, handleAddLocale, handleExport, handleImport, confirmDialog } = langs;
    const [activeSection, setActiveSection] = useState<Section>('gui');

    if (loading) return <div className="flex items-center justify-center h-full text-[var(--text-muted)]">{t('admin_languages.loading', 'Loading languages...')}</div>;

    const availableToAdd = catalog.filter(c => !locales.find(l => l.code === c.code));

    return (
        <div className="h-full flex flex-col overflow-hidden bg-[var(--bg-primary)]">
            {error && (
                <div className="mx-4 mt-3 px-3 py-2 rounded-lg text-sm flex items-center gap-2 [background:rgba(239,68,68,0.1)] [color:#ef4444]!">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{error}</span>
                    <button onClick={() => setError('')} className="ml-auto"><X className="w-3.5 h-3.5" /></button>
                </div>
            )}

            <div className="flex flex-1 overflow-hidden">
                <LocaleList {...langs} />

                {/* Right: Editor */}
                <div className="flex-1 flex flex-col overflow-hidden">
                    {selectedLocale ? (
                        <LocaleEditor
                            locale={selectedLocale}
                            activeSection={activeSection}
                            setActiveSection={setActiveSection}
                            onExport={() => handleExport(selectedLocale)}
                            onImport={() => handleImport(selectedLocale)}
                        />
                    ) : (
                        <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">
                            <div className="text-center">
                                <Globe className="w-12 h-12 mx-auto mb-3 opacity-30" />
                                <p className="text-sm">{t('admin_languages.empty', 'Add a language to get started')}</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Add Language Modal */}
            {showAddModal && (
                <AddLanguageModal
                    available={availableToAdd}
                    onAdd={handleAddLocale}
                    onClose={() => setShowAddModal(false)}
                />
            )}
            {confirmDialog}
        </div>
    );
};

export default LanguagesPanel;
