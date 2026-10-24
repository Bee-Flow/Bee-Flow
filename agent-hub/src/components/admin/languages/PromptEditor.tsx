import { Check, Copy } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import AiTranslateControl, { AiTranslateResult } from './AiTranslateControl';
import { LANGUAGES_API } from './useLanguages';
import useAiTranslate, { translateRequest } from '../../../hooks/useAiTranslate';
import { useTranslation } from '../../../hooks/useTranslation';
import { getLanguages, sendLanguagesJson } from '../../../api/languages';
import { logger } from '../../../utils/logger';

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
        <div className="w-56 shrink-0 border rounded-xl overflow-y-auto [border-color:var(--border-default)] [background:var(--bg-secondary)] [scrollbar-width:thin]">
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
                                onClick={() => onSelect(id)}
                                className={`w-full px-3 py-1.5 text-left text-xs flex items-center gap-2 transition-colors ${active ? 'bg-[var(--accent-primary)] text-white' : 'hover:bg-[var(--bg-tertiary)]'}`}
                                style={{ color: active ? '#fff' : 'var(--text-primary)' }}
                            >
                                <span className="truncate flex-1">{labels[id] || id}</span>
                                {translations[id] ? (
                                    <Check className="w-3 h-3 shrink-0" style={{ color: active ? '#fff' : '#22c55e' }} />
                                ) : (
                                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: active ? 'rgba(255,255,255,0.4)' : 'var(--text-muted)', opacity: 0.4 }} />
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
    saving: boolean;
    saved: boolean;
    onSave: () => void;
}

/** Right: the English default (read-only) next to the editable translation. */
function PromptSideBySide({ locale, label, defaultText, editText, setEditText, saving, saved, onSave }: PromptSideBySideProps) {
    const { t } = useTranslation();
    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between mb-2 shrink-0">
                <h4 className="text-sm font-semibold text-[var(--text-primary)]">{label}</h4>
                <div className="flex items-center gap-2">
                    {saved && <span className="text-xs text-green-500 flex items-center gap-1"><Check className="w-3 h-3" /> {t('admin_languages.saved', 'Saved')}</span>}
                    <button
                        onClick={() => setEditText(defaultText)}
                        className="px-2 py-1 rounded text-xs border hover:bg-[var(--bg-tertiary)] transition-colors border-[var(--border-default)] text-[var(--text-secondary)]"
                        title={t('admin_languages.copy_default_title', 'Copy English default into editor')}
                    >
                        <Copy className="w-3 h-3 inline mr-1" /> {t('admin_languages.copy_default', 'Copy Default')}
                    </button>
                    <button
                        onClick={onSave}
                        disabled={saving}
                        className="px-3 py-1 rounded-lg text-xs font-medium text-white disabled:opacity-50 transition-opacity bg-[var(--accent-primary)]"
                    >
                        {saving ? t('admin_languages.saving', 'Saving...') : t('admin_languages.save', 'Save')}
                    </button>
                </div>
            </div>

            <div className="flex-1 flex gap-3 overflow-hidden min-h-0">
                {/* Default (read-only) */}
                <div className="flex-1 flex flex-col overflow-hidden">
                    <div className="text-[10px] font-semibold uppercase tracking-wider mb-1 px-1 text-[var(--text-muted)]">{t('admin_languages.english_default', 'English Default')}</div>
                    <textarea
                        value={defaultText}
                        readOnly
                        className="flex-1 w-full px-3 py-2 rounded-lg border text-xs font-mono resize-none [border-color:var(--border-default)] [background:var(--bg-tertiary)] [color:var(--text-secondary)]! [outline:none] [scrollbar-width:thin]"
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
                        className="flex-1 w-full px-3 py-2 rounded-lg border text-xs font-mono resize-none focus:border-[var(--accent-primary)] [border-color:var(--border-default)]! [background:var(--bg-primary)] [color:var(--text-primary)]! [outline:none] [scrollbar-width:thin]"
                    />
                    <div className="text-[10px] mt-1 px-1 text-[var(--text-muted)]">{t('admin_languages.chars', '{n} chars', { n: editText.length })}</div>
                </div>
            </div>
        </div>
    );
}

/** The system prompts of one locale: pick one, translate it side by side. */
export default function PromptEditor({ locale }: { locale: string }) {
    const { t } = useTranslation();
    const [data, setData] = useState<PromptData | null>(null);
    const [translations, setTranslations] = useState<Record<string, string>>({});
    const [selectedPrompt, setSelectedPrompt] = useState<string | null>(null);
    const [editText, setEditText] = useState('');
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    const fetchData = useCallback(() => {
        getLanguages(`${locale}/prompts`)
            .then((r: Response) => r.json())
            .then((d: PromptData) => {
                setData(d);
                setTranslations(d.translations || {});
                if (d.promptIds?.length) setSelectedPrompt(cur => cur || d.promptIds![0]);
            });
    }, [locale]);

    useEffect(() => { fetchData(); }, [fetchData]);

    useEffect(() => {
        if (selectedPrompt) {
            setEditText(translations[selectedPrompt] || '');
            setSaved(false);
        }
    }, [selectedPrompt, translations]);

    const handleSave = async () => {
        if (!selectedPrompt) return;
        setSaving(true);
        try {
            const res = await sendLanguagesJson('PUT', `${locale}/prompts/${selectedPrompt}`, { text: editText });
            if (res.ok) {
                setTranslations(prev => ({ ...prev, [selectedPrompt]: editText }));
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
            }
        } catch (err) { logger.warn('prompt translation save failed', err); }
        setSaving(false);
    };

    const ai = useAiTranslate({
        request: (tier) => translateRequest(`${LANGUAGES_API}/${locale}/ai-translate-prompts`, tier),
        onReload: fetchData,
    });

    if (!data) return <div className="flex items-center justify-center h-full text-[var(--text-muted)]">Loading...</div>;

    const stats = data.stats || {};

    return (
        <div className="h-full flex flex-col overflow-hidden p-4">
            {/* Stats bar with AI Translate */}
            {locale !== 'en' && (
                <div className="flex items-center gap-3 mb-3 shrink-0">
                    <div className="flex-1 h-2 rounded-full overflow-hidden bg-[var(--bg-tertiary)]">
                        <div className="h-full rounded-full transition-all" style={{ width: `${pct(stats.translated, stats.total)}%`, background: (stats.translated as number) >= (stats.total as number) ? '#22c55e' : 'var(--accent-primary)' }} />
                    </div>
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
                        saving={saving}
                        saved={saved}
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
