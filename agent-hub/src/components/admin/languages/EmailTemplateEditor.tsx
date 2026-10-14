import { AlertCircle, Check, Languages, RotateCcw, Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import AiTranslateControl, { AiTranslateResult } from './AiTranslateControl';
import useAiTranslate, { translateRequest } from '../../../hooks/useAiTranslate';
import { useTranslation } from '../../../hooks/useTranslation';
import type { TranslateFn } from '../../../hooks/useTranslation';
import { LANGUAGES_API, getLanguages, sendLanguagesJson } from '../../../api/languages';

// Structured-field editor for the verification + welcome emails, per locale.
// Fields are plain text rendered into the branded shell; a live preview shows
// exactly what recipients will see. Empty field = fall back to the English
// default.

type Fields = Record<string, string>;

/** GET /api/languages/:locale/email-templates */
interface EmailTemplatesData {
    templateIds?: string[];
    fields?: string[];
    labels?: Record<string, string>;
    /** This locale's raw overrides per template. */
    templates?: Record<string, Fields>;
    defaults?: Record<string, Fields>;
    variables?: Record<string, string[]>;
    stats?: { missing?: number };
}

const FIELD_STYLE = { borderColor: 'var(--border-default)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none' };

const getFieldMeta = (t: TranslateFn): Record<string, { label: string; type: 'input' | 'textarea' }> => ({
    subject: { label: t('admin_languages.field_subject', 'Subject'), type: 'input' },
    title: { label: t('admin_languages.field_title', 'Title (header)'), type: 'input' },
    intro: { label: t('admin_languages.field_intro', 'Intro / greeting'), type: 'input' },
    body: { label: t('admin_languages.field_body', 'Body'), type: 'textarea' },
    ctaLabel: { label: t('admin_languages.field_ctalabel', 'Button label'), type: 'input' },
});

/**
 * The templates, the selected one's fields, save, and the debounced live
 * preview of the current (unsaved) edits.
 */
function useEmailTemplates(locale: string) {
    const [data, setData] = useState<EmailTemplatesData | null>(null);
    const [selected, setSelected] = useState('verification');
    const [fields, setFields] = useState<Fields>({});
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [previewHtml, setPreviewHtml] = useState('');

    // The reload is also the AI control's onReload, so it reads the template
    // that is selected at call time rather than being rebuilt per selection.
    const selectedRef = useRef(selected);
    useEffect(() => { selectedRef.current = selected; }, [selected]);
    const fetchData = useCallback(() => {
        getLanguages(`${locale}/email-templates`)
            .then((r: Response) => r.json())
            .then((d: EmailTemplatesData) => {
                setData(d);
                // Prefill with this locale's raw overrides; empty = use default (shown as placeholder).
                setFields({ ...(d.templates?.[selectedRef.current] || {}) });
            })
            .catch(() => { });
    }, [locale]);

    useEffect(() => { fetchData(); }, [fetchData]);

    // Debounced live preview reflecting current (unsaved) edits.
    useEffect(() => {
        if (!data) return;
        const timer = setTimeout(() => {
            sendLanguagesJson('POST', `${locale}/email-templates/${selected}/preview`, { fields })
                .then((r: Response) => r.json())
                .then((d: { html?: string }) => { if (d.html) setPreviewHtml(d.html); })
                .catch(() => { });
        }, 400);
        return () => clearTimeout(timer);
    }, [fields, selected, locale, data]);

    const handleSave = async () => {
        setSaving(true);
        try {
            const res = await sendLanguagesJson('PUT', `${locale}/email-templates`, { templateId: selected, fields });
            if (res.ok) {
                const d = await res.json();
                setData(prev => ({ ...prev, templates: d.templates }));
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
            }
        } catch { /* ignore */ }
        setSaving(false);
    };

    return { data, selected, setSelected, fields, setFields, saving, saved, setSaved, previewHtml, fetchData, handleSave };
}

/** Send the selected template (with its saved text) to an address. */
function TestEmailSender({ locale, selected, result, setResult }: {
    locale: string;
    selected: string;
    result: { ok?: boolean; error?: string } | null;
    setResult: (r: { ok?: boolean; error?: string } | null) => void;
}) {
    const { t } = useTranslation();
    const [testRecipient, setTestRecipient] = useState('');
    const [testing, setTesting] = useState(false);

    const handleTest = async () => {
        if (!testRecipient.trim()) return;
        setTesting(true);
        setResult(null);
        try {
            const res = await sendLanguagesJson('POST', `${locale}/email-templates/${selected}/test`, { testRecipient: testRecipient.trim() });
            const d = await res.json();
            setResult(res.ok ? { ok: true } : { error: d.error || t('admin_languages.email_error_send', 'Failed to send') });
        } catch (err) {
            setResult({ error: (err as Error).message });
        }
        setTesting(false);
    };

    return (
        <div className="border-t pt-3 border-[var(--border-default)]">
            <label className="text-xs font-medium block mb-1.5 text-[var(--text-secondary)]">{t('admin_languages.send_test_email', 'Send a test email')}</label>
            <div className="flex items-center gap-2">
                <input
                    type="email"
                    value={testRecipient}
                    onChange={e => setTestRecipient(e.target.value)}
                    placeholder="you@example.com"
                    className="flex-1 px-3 py-1.5 rounded-lg border text-sm focus:border-[var(--accent-primary)]"
                    style={FIELD_STYLE}
                />
                <button
                    onClick={handleTest}
                    disabled={testing || !testRecipient.trim()}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium flex items-center gap-1.5 border disabled:opacity-40 hover:bg-[var(--bg-tertiary)] transition-colors border-[var(--border-default)] text-[var(--text-secondary)]"
                >
                    {testing ? <span className="inline-block w-3.5 h-3.5 border-2 border-current/30 border-t-current rounded-full animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    {t('admin_languages.send_test', 'Send test')}
                </button>
            </div>
            {result && (
                <div className="mt-2 text-xs flex items-center gap-1.5" style={{ color: result.error ? '#ef4444' : '#22c55e' }}>
                    {result.error ? (<><AlertCircle className="w-3.5 h-3.5" /> {result.error}</>) : (<><Check className="w-3.5 h-3.5" /> {t('admin_languages.test_sent', 'Test email sent')}</>)}
                </div>
            )}
        </div>
    );
}

/** One template field; empty means the English default (shown as placeholder). */
function TemplateField({ fieldKey, value, placeholder, onChange }: { fieldKey: string; value: string; placeholder: string; onChange: (v: string) => void }) {
    const { t } = useTranslation();
    const meta = getFieldMeta(t)[fieldKey] || { label: fieldKey, type: 'input' };
    return (
        <div className="mb-3">
            <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-[var(--text-secondary)]">{meta.label}</label>
                {value && (
                    <button onClick={() => onChange('')} className="text-[10px] flex items-center gap-1 opacity-60 hover:opacity-100 text-[var(--text-muted)]" title={t('admin_languages.reset_title', 'Reset to default')}>
                        <RotateCcw className="w-3 h-3" /> {t('admin_languages.reset', 'Reset')}
                    </button>
                )}
            </div>
            {meta.type === 'textarea' ? (
                <textarea
                    value={value}
                    onChange={e => onChange(e.target.value)}
                    placeholder={placeholder}
                    rows={5}
                    className="w-full px-3 py-2 rounded-lg border text-sm resize-y focus:border-[var(--accent-primary)]"
                    style={FIELD_STYLE}
                />
            ) : (
                <input
                    value={value}
                    onChange={e => onChange(e.target.value)}
                    placeholder={placeholder}
                    className="w-full px-3 py-2 rounded-lg border text-sm focus:border-[var(--accent-primary)]"
                    style={FIELD_STYLE}
                />
            )}
        </div>
    );
}

function EmailPreview({ html }: { html: string }) {
    const { t } = useTranslation();
    return (
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wider mb-1.5 px-1 text-[var(--text-muted)]">{t('admin_languages.live_preview', 'Live preview')}</div>
            <div className="flex-1 rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-default)', background: '#f5f5f5' }}>
                <iframe
                    title={t('admin_languages.email_preview', 'Email preview')}
                    srcDoc={html}
                    sandbox=""
                    className="w-full h-full"
                    style={{ border: 'none', background: '#f5f5f5' }}
                />
            </div>
        </div>
    );
}

/** The verification and welcome emails of one locale, with a live preview and a test send. */
export default function EmailTemplateEditor({ locale }: { locale: string }) {
    const { t } = useTranslation();
    const { data, selected, setSelected, fields, setFields, saving, saved, setSaved, previewHtml, fetchData, handleSave } = useEmailTemplates(locale);
    const [testResult, setTestResult] = useState<{ ok?: boolean; error?: string } | null>(null);

    // When switching template, repopulate from the loaded overrides.
    const [shownTemplate, setShownTemplate] = useState(selected);
    if (shownTemplate !== selected) {
        setShownTemplate(selected);
        if (data) setFields({ ...(data.templates?.[selected] || {}) });
        setSaved(false);
        setTestResult(null);
    }

    const ai = useAiTranslate({
        request: (tier) => translateRequest(`${LANGUAGES_API}/${locale}/ai-translate-emails`, tier),
        onReload: fetchData,
    });

    if (!data) return <div className="flex items-center justify-center h-full text-[var(--text-muted)]">Loading...</div>;

    const defaults = data.defaults?.[selected] || {};
    const labels = data.labels || {};
    const variables = data.variables?.[selected] || [];
    const setField = (key: string, val: string) => setFields(prev => ({ ...prev, [key]: val }));

    return (
        <div className="h-full flex flex-col overflow-hidden p-4">
            {/* Top bar: template selector + AI translate */}
            <div className="flex items-center gap-2 mb-3 shrink-0 flex-wrap">
                {(data.templateIds || []).map(id => (
                    <button
                        key={id}
                        onClick={() => setSelected(id)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${selected === id ? 'bg-[var(--accent-primary)] text-white' : 'text-[var(--text-secondary)] border hover:bg-[var(--bg-tertiary)]'}`}
                        style={selected === id ? {} : { borderColor: 'var(--border-default)' }}
                    >
                        {labels[id] || id}
                    </button>
                ))}
                {locale !== 'en' && (
                    <AiTranslateControl
                        className="ml-auto flex items-center gap-1.5"
                        tier={ai.tier}
                        onTierChange={ai.setTier}
                        onTranslate={ai.run}
                        translating={ai.translating}
                        missing={data.stats?.missing}
                        icon={<Languages className="w-3.5 h-3.5" />}
                        gradient={false}
                        showCount={false}
                    />
                )}
            </div>
            <AiTranslateResult result={ai.result} />

            <div className="flex-1 flex gap-4 overflow-hidden min-h-0">
                {/* Left: fields form */}
                <div className="flex-1 flex flex-col overflow-y-auto pr-1 min-w-0" style={{ scrollbarWidth: 'thin' }}>
                    {/* Variable hint chips */}
                    {variables.length > 0 && (
                        <div className="flex items-center gap-1.5 flex-wrap mb-3">
                            <span className="text-[11px] text-[var(--text-muted)]">Variables:</span>
                            {variables.map(v => (
                                <code key={v} className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">{`{{${v}}}`}</code>
                            ))}
                        </div>
                    )}
                    {(data.fields || []).map(key => (
                        <TemplateField key={key} fieldKey={key} value={fields[key] ?? ''} placeholder={defaults[key] || ''} onChange={(v) => setField(key, v)} />
                    ))}

                    {/* Save + send test */}
                    <div className="flex items-center gap-2 mt-1 mb-3 flex-wrap">
                        <button
                            onClick={handleSave}
                            disabled={saving}
                            className="px-4 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-50 transition-opacity bg-[var(--accent-primary)]"
                        >
                            {saving ? t('admin_languages.saving', 'Saving...') : t('admin_languages.save', 'Save')}
                        </button>
                        {saved && <span className="text-xs text-green-500 flex items-center gap-1"><Check className="w-3.5 h-3.5" /> {t('admin_languages.saved', 'Saved')}</span>}
                    </div>

                    <TestEmailSender locale={locale} selected={selected} result={testResult} setResult={setTestResult} />
                </div>

                <EmailPreview html={previewHtml} />
            </div>
        </div>
    );
}
