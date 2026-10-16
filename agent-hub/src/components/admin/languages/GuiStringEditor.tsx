import { Check, Copy, Search } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import AiTranslateControl, { AiTranslateResult } from './AiTranslateControl';
import { LANGUAGES_API } from './useLanguages';
import useAiTranslate, { translateRequest } from '../../../hooks/useAiTranslate';
import { useTranslation } from '../../../hooks/useTranslation';
import { getLanguages, sendLanguagesJson } from '../../../api/languages';

const FIELD_STYLE = { borderColor: 'var(--border-default)', color: 'var(--text-primary)', outline: 'none' };
const TH_STYLE = { color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-default)' };

interface GuiStats {
    translated?: number;
    total?: number;
    missing?: number;
    progress?: number;
}

/** GET /api/languages/:locale/gui */
interface GuiData {
    defaults?: Record<string, string>;
    translations?: Record<string, string>;
    namespaces?: string[];
    stats?: GuiStats;
}

type ShowOnly = 'all' | 'missing' | 'translated';

interface GuiStringRowProps {
    stringKey: string;
    defaultValue: string;
    translation: string;
    onSave: (key: string, value: string) => void;
    isSaved: boolean;
    isEnglish: boolean;
}

/** One key: the English default and an inline translation input that saves on blur. */
const GuiStringRow = memo(function GuiStringRow({ stringKey, defaultValue, translation, onSave, isSaved, isEnglish }: GuiStringRowProps) {
    const { t } = useTranslation();
    const [value, setValue] = useState(translation);
    const [editing, setEditing] = useState(false);

    useEffect(() => setValue(translation), [translation]);

    const handleBlur = () => {
        setEditing(false);
        if (value !== translation) onSave(stringKey, value);
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { setValue(translation); setEditing(false); }
    };

    return (
        <tr className="group hover:bg-[var(--bg-secondary)] transition-colors" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <td className="px-3 py-1.5 font-mono text-[11px] break-all text-[var(--text-muted)]">{stringKey}</td>
            <td className="px-3 py-1.5 text-[var(--text-secondary)]">{defaultValue}</td>
            <td className="px-3 py-1">
                {isEnglish ? (
                    <span className="text-[var(--text-muted)]">{defaultValue}</span>
                ) : (
                    <div className="flex items-center gap-1">
                        <input
                            value={value}
                            onChange={e => setValue(e.target.value)}
                            onFocus={() => setEditing(true)}
                            onBlur={handleBlur}
                            onKeyDown={handleKeyDown}
                            placeholder={defaultValue}
                            className="w-full px-2 py-1 rounded border bg-transparent text-xs transition-colors focus:border-[var(--accent-primary)] focus:bg-[var(--bg-primary)]"
                            style={{ borderColor: editing ? 'var(--accent-primary)' : 'transparent', color: 'var(--text-primary)', outline: 'none' }}
                        />
                        {isSaved && <Check className="w-3.5 h-3.5 text-green-500 shrink-0" />}
                        {!value && (
                            <button onClick={() => { setValue(defaultValue); onSave(stringKey, defaultValue); }} className="p-1 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity" title={t('admin_languages.copy_default_short', 'Copy default')}>
                                <Copy className="w-3 h-3" />
                            </button>
                        )}
                    </div>
                )}
            </td>
        </tr>
    );
});

/** Load the locale's GUI strings; `reload` refetches after an AI run. */
function useGuiStrings(locale: string) {
    const [data, setData] = useState<GuiData | null>(null);
    const [translations, setTranslations] = useState<Record<string, string>>({});
    const [savedKey, setSavedKey] = useState<string | null>(null);

    const reload = useCallback(() => {
        getLanguages(`${locale}/gui`)
            .then((r: Response) => r.json())
            .then((d: GuiData) => {
                setData(d);
                setTranslations(d.translations || {});
            });
    }, [locale]);

    useEffect(() => { reload(); }, [locale]);

    const saveTranslation = useCallback(async (key: string, value: string) => {
        try {
            const res = await sendLanguagesJson('PATCH', `${locale}/gui`, { updates: { [key]: value } });
            if (res.ok) {
                const result = await res.json();
                setTranslations(result.translations);
                setSavedKey(key);
                setTimeout(() => setSavedKey(null), 1500);
            }
        } catch { }
    }, [locale]);

    return { data, translations, savedKey, reload, saveTranslation };
}

interface FilterState {
    search: string;
    namespace: string;
    showOnly: ShowOnly;
}

function filterKeys(defaults: Record<string, string>, translations: Record<string, string>, { search, namespace, showOnly }: FilterState): string[] {
    return Object.keys(defaults).filter(key => {
        if (namespace !== 'all' && !key.startsWith(namespace + '.')) return false;
        if (showOnly === 'missing' && translations[key]) return false;
        if (showOnly === 'translated' && !translations[key]) return false;
        if (search && !key.toLowerCase().includes(search.toLowerCase()) && !defaults[key].toLowerCase().includes(search.toLowerCase())) return false;
        return true;
    });
}

interface GuiFiltersProps extends FilterState {
    setSearch: (v: string) => void;
    setNamespace: (v: string) => void;
    setShowOnly: (v: ShowOnly) => void;
    namespaces: string[];
    keyCount: number;
    stats: GuiStats;
}

function GuiFilters({ search, setSearch, namespace, setNamespace, showOnly, setShowOnly, namespaces, keyCount, stats }: GuiFiltersProps) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-2 mb-3 shrink-0 flex-wrap">
            <div className="relative flex-1 min-w-48">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('admin_languages.search_keys', 'Search keys or values...')} className="w-full pl-8 pr-3 py-1.5 rounded-lg text-xs border bg-[var(--bg-secondary)]" style={FIELD_STYLE} />
            </div>
            <select value={namespace} onChange={e => setNamespace(e.target.value)} className="px-2 py-1.5 rounded-lg text-xs border bg-[var(--bg-secondary)]" style={FIELD_STYLE}>
                <option value="all">{t('admin_languages.all_sections', 'All Sections')}</option>
                {namespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
            </select>
            <select value={showOnly} onChange={e => setShowOnly(e.target.value as ShowOnly)} className="px-2 py-1.5 rounded-lg text-xs border bg-[var(--bg-secondary)]" style={FIELD_STYLE}>
                <option value="all">{t('admin_languages.filter_all', 'All ({n})', { n: keyCount })}</option>
                <option value="missing">{t('admin_languages.filter_missing', 'Missing ({n})', { n: stats.missing || 0 })}</option>
                <option value="translated">{t('admin_languages.filter_translated', 'Translated ({n})', { n: stats.translated || 0 })}</option>
            </select>
        </div>
    );
}

/** Every GUI string of one locale, filterable, edited inline. */
export default function GuiStringEditor({ locale }: { locale: string }) {
    const { t } = useTranslation();
    const { data, translations, savedKey, reload, saveTranslation } = useGuiStrings(locale);
    const [search, setSearch] = useState('');
    const [namespace, setNamespace] = useState('all');
    const [showOnly, setShowOnly] = useState<ShowOnly>('all');

    // GUI translate hits two endpoints in parallel (GUI strings + system
    // prompts) and folds the prompt count into the success message; the other
    // sub-panels translate a single endpoint (see useAiTranslate).
    const ai = useAiTranslate({
        request: async (tier) => {
            const [result, promptResult] = await Promise.all([
                translateRequest(`${LANGUAGES_API}/${locale}/ai-translate`, tier),
                // Don't fail GUI translation if prompts fail.
                translateRequest(`${LANGUAGES_API}/${locale}/ai-translate-prompts`, tier).catch(() => null),
            ]);
            if (result.success && promptResult?.success && (promptResult.translated as number) > 0) {
                return { ...result, message: t('admin_languages.ai_plus_prompts', '{message} + {n} system prompts', { message: result.message, n: promptResult.translated }) };
            }
            return result;
        },
        onReload: reload,
    });

    if (!data) return <div className="flex items-center justify-center h-full text-[var(--text-muted)]">Loading...</div>;

    const defaults = data.defaults || {};
    const filteredKeys = filterKeys(defaults, translations, { search, namespace, showOnly });
    const stats = data.stats || {};

    return (
        <div className="h-full flex flex-col p-4 overflow-hidden">
            {/* Stats bar */}
            <div className="flex items-center gap-4 mb-3 shrink-0">
                <div className="flex-1 h-2 rounded-full overflow-hidden bg-[var(--bg-tertiary)]">
                    <div className="h-full rounded-full transition-all" style={{ width: `${stats.progress || 0}%`, background: (stats.progress || 0) >= 100 ? '#22c55e' : 'var(--accent-primary)' }} />
                </div>
                <span className="text-xs font-medium shrink-0 text-[var(--text-secondary)]">
                    {stats.translated || 0} / {stats.total || 0} ({stats.progress || 0}%)
                </span>
                {locale !== 'en' && (
                    <AiTranslateControl tier={ai.tier} onTierChange={ai.setTier} onTranslate={ai.run} translating={ai.translating} missing={stats.missing} />
                )}
            </div>
            <AiTranslateResult result={ai.result} />

            <GuiFilters
                search={search} setSearch={setSearch}
                namespace={namespace} setNamespace={setNamespace}
                showOnly={showOnly} setShowOnly={setShowOnly}
                namespaces={data.namespaces || []}
                keyCount={Object.keys(defaults).length}
                stats={stats}
            />

            {/* Table */}
            <div className="flex-1 overflow-y-auto rounded-xl border" style={{ borderColor: 'var(--border-default)', scrollbarWidth: 'thin' }}>
                <table className="w-full text-xs">
                    <thead className="sticky top-0 z-10" style={{ background: 'var(--bg-tertiary)' }}>
                        <tr>
                            <th className="text-left px-3 py-2 font-semibold w-1/4" style={TH_STYLE}>{t('admin_languages.col_key', 'Key')}</th>
                            <th className="text-left px-3 py-2 font-semibold w-[37.5%]" style={TH_STYLE}>{t('admin_languages.english_default', 'English Default')}</th>
                            <th className="text-left px-3 py-2 font-semibold w-[37.5%]" style={TH_STYLE}>{t('admin_languages.col_translation', 'Translation')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filteredKeys.map(key => (
                            <GuiStringRow
                                key={key}
                                stringKey={key}
                                defaultValue={defaults[key]}
                                translation={translations[key] || ''}
                                onSave={saveTranslation}
                                isSaved={savedKey === key}
                                isEnglish={locale === 'en'}
                            />
                        ))}
                        {filteredKeys.length === 0 && (
                            <tr><td colSpan={3} className="text-center py-8 text-[var(--text-muted)]">{t('admin_languages.no_keys', 'No matching keys')}</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
