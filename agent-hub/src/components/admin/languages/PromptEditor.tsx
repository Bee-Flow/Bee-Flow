import { Check, Copy } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import AiTranslateControl, { AiTranslateResult } from './AiTranslateControl';
import { LANGUAGES_API } from './useLanguages';
import useAiTranslate, { translateRequest } from '@/hooks/useAiTranslate';
import { useTranslation } from '@/hooks/useTranslation';
import { getLanguages, sendLanguagesJson } from '@/api/languages';
import { logger } from '@/utils/logger';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';
import SaveStatus from '@/components/shared/SaveStatus';
import { SECONDARY_BTN } from '@/components/shared/adminUi';
import Button from '@/components/shared/Button';
import ProgressFill from './ProgressFill';

/** GET /api/languages/:locale/prompts */
interface PromptData {
    promptIds?: string[];
    categories?: Record<string, string[]>;
    labels?: Record<string, string>;
    defaults?: Record<string, string>;
    translations?: Record<string, string>;
    stats?: { translated?: number; total?: number; missing?: number };
}

const pct = (translated: number | undefined, total: number | undefined) =>
    (total || 0) > 0 ? Math.round(((translated || 0) / (total as number)) * 100) : 0;

interface PromptListProps {
    data: PromptData;
    translations: Record<string, string>;
    selectedPrompt: string | null;
    onSelect: (id: string) => void;
}

/** Left: the prompts by category, each marked translated or not. */
function PromptList({ data, translations, selectedPrompt, onSelect }: PromptListProps) {
    const { t } = useTranslation();
    const labels = data.labels || {};
    const stats = data.stats || {};
    return (
        <div className="w-56 shrink-0 border rounded-xl overflow-y-auto border-[var(--border-default)] bg-[var(--bg-secondary)] [scrollbar-width:thin]">
            <div className="p-2 border-b border-[var(--border-default)]">
                <span className="text-xs font-medium text-[var(--text-muted)]">
                    {t('admin_languages.prompt_stats', '{translated} / {total} translated', { translated: stats.translated || 0, total: stats.total || 0 })}
                </span>
            </div>
            {Object.entries(data.categories || {}).map(([cat, ids]) => (
                <div key={cat}>
                    <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">{cat}</div>
                    {ids.map(id => {
                        const active = selectedPrompt === id;
                        return (
                            <button
                                key={id}
                                type="button"
                                onClick={() => onSelect(id)}
                                aria-current={active ? 'true' : undefined}
                                className={`w-full px-3 py-1.5 text-left text-xs flex items-center gap-2 transition-colors ${active ? 'bg-[var(--bg-tertiary)] font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'}`}
                            >
                                <span className="truncate flex-1">{labels[id] || id}</span>
                                {translations[id] ? (
                                    <Check className="w-3 h-3 shrink-0 text-[var(--success-ink)]" aria-hidden="true" />
                                ) : (
                                    <span className="w-1.5 h-1.5 rounded-full shrink-0 opacity-40 bg-[var(--text-muted)]" aria-hidden="true" />
                                )}
                            </button>
                        );
                    })}
                </div>
            ))}
        </div>
    );
}

interface PromptSideBySideProps {
    locale: string;
    label: string;
    defaultText: string;
    editText: string;
    setEditText: (v: string) => void;
    saveState: 'idle' | 'saving' | 'saved' | 'error';
    savedAt: Date | null;
    onSave: () => void;
}

/** Right: the English default (read-only) next to the editable translation. */
function PromptSideBySide({ locale, label, defaultText, editText, setEditText, saveState, savedAt, onSave }: PromptSideBySideProps) {
    const { t } = useTranslation();
    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between mb-2 shrink-0">
                <h4 className="text-sm font-semibold text-[var(--text-primary)]">{label}</h4>
                <div className="flex items-center gap-2">
                    <SaveStatus saveState={saveState} lastSavedAt={savedAt} onRetry={onSave} />
                    <button
                        type="button"
                        onClick={() => setEditText(defaultText)}
                        className={SECONDARY_BTN}
                        title={t('admin_languages.copy_default_title', 'Copy English default into editor')}
                    >
                        <Copy className="w-3 h-3" aria-hidden="true" /> {t('admin_languages.copy_default', 'Copy Default')}
                    </button>
                    <Button size="sm" onClick={onSave} busy={saveState === 'saving'}>
                        {t('admin_languages.save', 'Save')}
                    </Button>
                </div>
            </div>

            <div className="flex-1 flex gap-3 overflow-hidden min-h-0">
                {/* Default (read-only) */}
                <div className="flex-1 flex flex-col overflow-hidden">
                    <div className="text-[10px] font-semibold uppercase tracking-wider mb-1 px-1 text-[var(--text-muted)]">{t('admin_languages.english_default', 'English Default')}</div>
                    <textarea
                        value={defaultText}
                        readOnly
                        className="flex-1 w-full px-3 py-2 rounded-lg border text-xs font-mono resize-none border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] outline-none [scrollbar-width:thin]"
                    />
                    <div className="text-[10px] mt-1 px-1 text-[var(--text-muted)]">{t('admin_languages.chars', '{n} chars', { n: defaultText.length })}</div>
                </div>

                {/* Translation (editable) */}
                <div className="flex-1 flex flex-col overflow-hidden">
                    <div className="text-[10px] font-semibold uppercase tracking-wider mb-1 px-1 text-[var(--text-muted)]">{t('admin_languages.translation_locale', 'Translation ({locale})', { locale: locale.toUpperCase() })}</div>
                    <textarea
                        value={editText}
                        onChange={e => setEditText(e.target.value)}
                        placeholder={t('admin_languages.enter_translation', 'Enter translation...')}
                        className="flex-1 w-full px-3 py-2 rounded-lg border text-xs font-mono resize-none border-[var(--border-default)] focus:border-[var(--accent-primary)] bg-[var(--bg-primary)] text-[var(--text-primary)] outline-none [scrollbar-width:thin]"
                    />
                    <div className="text-[10px] mt-1 px-1 text-[var(--text-muted)]">{t('admin_languages.chars', '{n} chars', { n: editText.length })}</div>
                </div>
            </div>
        </div>
    );
}

const NO_TRANSLATIONS: Record<string, string> = {};

/** The picked prompt, or until one is picked the first one the server lists. */
function shownPrompt(picked: string | null, data: PromptData | null): string | null {
    return picked || data?.promptIds?.[0] || null;
}

/** One locale's prompts and their translations; a save writes the translation into the cached read. */
function usePromptTranslations(locale: string, onSaved: (ok: boolean) => void) {
    const queryClient = useQueryClient();
    const key = ['languages', locale, 'prompts'] as const;
    const query = useQuery<PromptData>({
        queryKey: key,
        staleTime: 0,
        retry: false,
        queryFn: async () => (await getLanguages(`${locale}/prompts`)).json(),
    });
    const { refetch } = query;
    const fetchData = useCallback(() => { void refetch(); }, [refetch]);
    const save = useMutation({
        mutationFn: async ({ promptId, text }: { promptId: string; text: string }) => {
            const res = await sendLanguagesJson('PUT', `${locale}/prompts/${promptId}`, { text });
            return res.ok;
        },
        onSuccess: (ok, { promptId, text }) => {
            onSaved(ok);
            if (!ok) return;
            queryClient.setQueryData<PromptData>(key, (prev) => (prev ? { ...prev, translations: { ...prev.translations, [promptId]: text } } : prev));
        },
        onError: (err) => {
            logger.warn('prompt translation save failed', err);
            onSaved(false);
        },
    });
    return { data: query.data ?? null, translations: query.data?.translations ?? NO_TRANSLATIONS, fetchData, save };
}

/** The system prompts of one locale: pick one, translate it side by side. */
export default function PromptEditor({ locale }: { locale: string }) {
    const { t } = useTranslation();
    // When the open prompt's translation was last stored; null until a save of THIS prompt.
    const [savedAt, setSavedAt] = useState<Date | null>(null);
    const [saveFailed, setSaveFailed] = useState(false);
    const { data, translations, fetchData, save } = usePromptTranslations(locale, (ok) => {
        setSaveFailed(!ok);
        if (ok) setSavedAt(new Date());
    });
    const [pickedPrompt, setSelectedPrompt] = useState<string | null>(null);
    const selectedPrompt = shownPrompt(pickedPrompt, data);
    const [editText, setEditText] = useState('');
    // A new read refills the editor; only ANOTHER prompt starts the save status
    // over. A save writes its text into the cached read, and resetting the
    // status on that change would wipe the "Saved" it just set.
    useAdjustOnChange([selectedPrompt, translations], ([previousPrompt]) => {
        if (selectedPrompt) {
            setEditText(translations[selectedPrompt] || '');
            if (previousPrompt !== selectedPrompt) {
                setSavedAt(null);
                setSaveFailed(false);
            }
        }
    });

    const saveState = save.isPending ? 'saving' : saveFailed ? 'error' : savedAt ? 'saved' : 'idle';
    const handleSave = () => {
        if (!selectedPrompt) return;
        save.mutate({ promptId: selectedPrompt, text: editText });
    };

    const ai = useAiTranslate({
        request: (tier) => translateRequest(`${LANGUAGES_API}/${locale}/ai-translate-prompts`, tier),
        onReload: fetchData,
    });

    if (!data) return <div className="flex items-center justify-center h-full text-[var(--text-muted)]">{t('common.loading', 'Loading...')}</div>;

    const stats = data.stats || {};

    return (
        <div className="h-full flex flex-col overflow-hidden p-4">
            {/* Stats bar with AI Translate */}
            {locale !== 'en' && (
                <div className="flex items-center gap-3 mb-3 shrink-0">
                    <ProgressFill percent={pct(stats.translated, stats.total)} />
                    <span className="text-xs font-medium shrink-0 text-[var(--text-secondary)]">
                        {stats.translated || 0} / {stats.total || 0} ({pct(stats.translated, stats.total)}%)
                    </span>
                    <AiTranslateControl tier={ai.tier} onTierChange={ai.setTier} onTranslate={ai.run} translating={ai.translating} missing={stats.missing} />
                </div>
            )}
            <AiTranslateResult result={ai.result} />

            {/* Main content */}
            <div className="flex-1 flex overflow-hidden gap-3 min-h-0">
                <PromptList data={data} translations={translations} selectedPrompt={selectedPrompt} onSelect={setSelectedPrompt} />
                {selectedPrompt ? (
                    <PromptSideBySide
                        locale={locale}
                        label={(data.labels || {})[selectedPrompt] || selectedPrompt}
                        defaultText={(data.defaults || {})[selectedPrompt] || ''}
                        editText={editText}
                        setEditText={setEditText}
                        saveState={saveState}
                        savedAt={savedAt}
                        onSave={handleSave}
                    />
                ) : (
                    <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">
                        <p className="text-sm">{t('admin_languages.select_prompt', 'Select a prompt to translate')}</p>
                    </div>
                )}
            </div>
        </div>
    );
}
