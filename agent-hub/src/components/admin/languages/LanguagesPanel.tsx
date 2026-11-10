import { AlertCircle, Download, FileText, Globe, Languages, Mail, Plus, Star, Trash2, Upload, X } from 'lucide-react';
import { useState } from 'react';
import AddLanguageModal from './AddLanguageModal';
import EmailTemplateEditor from './EmailTemplateEditor';
import GuiStringEditor from './GuiStringEditor';
import PromptEditor from './PromptEditor';
import useLanguages from './useLanguages';
import type { LanguagesState } from './useLanguages';
import { useTranslation } from '@/hooks/useTranslation';
import EmptyState from '@/components/shared/EmptyState';
import SectionHeader from '@/components/shared/SectionHeader';
import Spinner from '@/components/shared/Spinner';
import StudioShell from '@/components/shared/StudioShell';
import Tabs from '@/components/shared/Tabs';
import { ALERT_ERROR, CHIP, QUIET_BTN, SECONDARY_BTN } from '@/components/mcpLibrary/ui';

type Section = 'gui' | 'prompts' | 'emails';

type LocaleListProps = Pick<LanguagesState,
    'locales' | 'selectedLocale' | 'setSelectedLocale' | 'setShowAddModal'
    | 'handleSetDefault' | 'handleExport' | 'handleImport' | 'handleDeleteLocale'>;

const ROW_ACTION = 'rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]';

/** The sidebar: the installed locales, with per-locale actions on hover (and on the current one). */
function LocaleList({ locales, selectedLocale, setSelectedLocale, handleSetDefault, handleExport, handleImport, handleDeleteLocale }: Omit<LocaleListProps, 'setShowAddModal'>) {
    const { t } = useTranslation();
    return (
        <nav aria-label={t('admin_languages.title', 'Languages')} className="flex flex-row gap-0.5 overflow-x-auto p-2 md:flex-col md:overflow-x-visible">
            {locales.map(locale => {
                const active = selectedLocale === locale.code;
                return (
                    <div
                        key={locale.code}
                        className={`group flex shrink-0 items-center gap-1 rounded-md pr-1 md:shrink ${active ? 'bg-[var(--bg-tertiary)]' : 'hover:bg-[var(--bg-secondary)]'}`}
                    >
                        <button
                            type="button"
                            onClick={() => setSelectedLocale(locale.code)}
                            aria-current={active ? 'page' : undefined}
                            className={`flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm ${active ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                        >
                            <span className="truncate">{locale.name}</span>
                            <span className="text-xs text-[var(--text-tertiary)]">{locale.code}</span>
                            {locale.isDefault && <span className={CHIP}>{t('admin_languages.default', 'Default')}</span>}
                        </button>
                        {locale.code !== 'en' && (
                            <div className={`flex items-center gap-0.5 transition-opacity ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}>
                                {!locale.isDefault && (
                                    <button type="button" onClick={() => handleSetDefault(locale.code)} className={ROW_ACTION} title={t('admin_languages.set_default', 'Set as default')} aria-label={t('admin_languages.set_default', 'Set as default')}>
                                        <Star className="h-3 w-3" aria-hidden="true" />
                                    </button>
                                )}
                                <button type="button" onClick={() => handleExport(locale.code)} className={ROW_ACTION} title={t('admin_languages.export', 'Export')} aria-label={t('admin_languages.export', 'Export')}>
                                    <Download className="h-3 w-3" aria-hidden="true" />
                                </button>
                                <button type="button" onClick={() => handleImport(locale.code)} className={ROW_ACTION} title={t('admin_languages.import', 'Import')} aria-label={t('admin_languages.import', 'Import')}>
                                    <Upload className="h-3 w-3" aria-hidden="true" />
                                </button>
                                <button type="button" onClick={() => handleDeleteLocale(locale.code)} className={ROW_ACTION} title={t('admin_languages.delete', 'Delete')} aria-label={t('admin_languages.delete', 'Delete')}>
                                    <Trash2 className="h-3 w-3" aria-hidden="true" />
                                </button>
                            </div>
                        )}
                    </div>
                );
            })}
        </nav>
    );
}

interface LocaleEditorProps {
    locale: string;
    localeName: string;
    activeSection: Section;
    setActiveSection: (s: Section) => void;
    onExport: () => void;
    onImport: () => void;
}

/** The main pane: the locale's name, export/import, the section tabs and the selected section's editor. */
function LocaleEditor({ locale, localeName, activeSection, setActiveSection, onExport, onImport }: LocaleEditorProps) {
    const { t } = useTranslation();
    const sections = [
        { id: 'gui' as const, label: t('admin_languages.tab_gui', 'GUI Translations'), icon: <Languages className="h-3.5 w-3.5" aria-hidden="true" /> },
        { id: 'prompts' as const, label: t('admin_languages.tab_prompts', 'System Prompts'), icon: <FileText className="h-3.5 w-3.5" aria-hidden="true" /> },
        { id: 'emails' as const, label: t('admin_languages.tab_emails', 'Email Templates'), icon: <Mail className="h-3.5 w-3.5" aria-hidden="true" /> },
    ];
    return (
        <div className="flex h-full flex-col">
            <div className="flex shrink-0 flex-col gap-3 px-4 pt-5">
                <SectionHeader
                    title={localeName}
                    description={locale}
                    status={(
                        <div className="flex items-center gap-2">
                            <button type="button" onClick={onExport} className={SECONDARY_BTN}>
                                <Download className="h-3.5 w-3.5" aria-hidden="true" /> {t('admin_languages.export', 'Export')}
                            </button>
                            <button type="button" onClick={onImport} className={SECONDARY_BTN}>
                                <Upload className="h-3.5 w-3.5" aria-hidden="true" /> {t('admin_languages.import', 'Import')}
                            </button>
                        </div>
                    )}
                />
                <Tabs value={activeSection} onChange={setActiveSection} items={sections} size="sm" ariaLabel={localeName} />
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
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
        </div>
    );
}

/** Admin → Languages: installed locales and, per locale, the GUI strings, system prompts and email templates. */
const LanguagesPanel = () => {
    const { t } = useTranslation();
    const langs = useLanguages();
    const { locales, catalog, selectedLocale, loading, error, setError, showAddModal, setShowAddModal, handleAddLocale, handleExport, handleImport, confirmDialog } = langs;
    const [activeSection, setActiveSection] = useState<Section>('gui');

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--text-secondary)]">
                <Spinner size="sm" /> {t('admin_languages.loading', 'Loading languages...')}
            </div>
        );
    }

    const availableToAdd = catalog.filter(c => !locales.find(l => l.code === c.code));
    const selectedName = locales.find(l => l.code === selectedLocale)?.name || selectedLocale || '';

    return (
        <div className="flex h-full flex-col overflow-hidden bg-[var(--bg-primary)]">
            {error && (
                <div className={`${ALERT_ERROR} mx-4 mt-3`} role="alert">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{error}</span>
                    <button type="button" onClick={() => setError('')} className="ml-auto" aria-label={t('common.close', 'Close')}><X className="h-3.5 w-3.5" /></button>
                </div>
            )}

            <div className="min-h-0 flex-1">
                <StudioShell
                    responsive
                    sidebarTitle={t('admin_languages.title', 'Languages')}
                    sidebarActions={(
                        <button type="button" onClick={() => setShowAddModal(true)} className={QUIET_BTN} title={t('admin_languages.add_language_title', 'Add language')} aria-label={t('admin_languages.add_language_title', 'Add language')}>
                            <Plus className="h-4 w-4" aria-hidden="true" />
                        </button>
                    )}
                    sidebar={<LocaleList {...langs} />}
                >
                    {selectedLocale ? (
                        <LocaleEditor
                            locale={selectedLocale}
                            localeName={selectedName}
                            activeSection={activeSection}
                            setActiveSection={setActiveSection}
                            onExport={() => handleExport(selectedLocale)}
                            onImport={() => handleImport(selectedLocale)}
                        />
                    ) : (
                        <EmptyState
                            icon={<Globe className="h-10 w-10" strokeWidth={1.5} />}
                            title={t('admin_languages.empty', 'Add a language to get started')}
                        />
                    )}
                </StudioShell>
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
