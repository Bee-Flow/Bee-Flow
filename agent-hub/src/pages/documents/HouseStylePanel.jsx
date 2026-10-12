import { ArrowLeft, Check, Loader2, AlertTriangle, Upload, Trash2 } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import useTranslation from '../../hooks/useTranslation';
import { getHouseStyle, saveHouseStyle, fileToDataUrl, previewDeckTheme } from './documentsApi';
import DeckPreview from './DeckPreview';
import DeckLookFields, { DECK_FALLBACK, DEFAULT_DECK } from './DeckLookFields';

/**
 * The organisation's letterhead: logo, colours, font and the company details
 * that go on every invoice.
 *
 * WHY THE COMPANY DETAILS ARE HERE AND NOT DERIVED FROM THE ORG RECORD. An
 * earlier version of this product read them straight off the organisation
 * (name, address, KvK) and offered no way to change them for documents. That
 * conflates two things: the org record is who you are in the system, and a
 * letterhead is what you put on paper — which is often a trading name, a
 * different postal address, and a VAT number the org row never had.
 *
 * `enabled` is the master switch, and it starts OFF: nothing is injected into
 * anybody's document until somebody has actually filled this in. Per-document
 * opt-out is separate and lives in the editor's toolbar.
 */

const TEXT_FIELDS = [
    { key: 'companyName', labelKey: 'documents.style.company_name', fallback: 'Company name', placeholder: 'Van Dijk Groep' },
    { key: 'companyTagline', labelKey: 'documents.style.tagline', fallback: 'Tagline', placeholder: 'Advies & Staalbouw' },
    { key: 'companyAddress', labelKey: 'documents.style.address', fallback: 'Address', placeholder: 'Zwolleweg 12, 8011 AB Zwolle' },
    { key: 'companyEmail', labelKey: 'documents.style.email', fallback: 'E-mail', placeholder: 'facturen@vandijk.nl' },
    { key: 'companyPhone', labelKey: 'documents.style.phone', fallback: 'Phone', placeholder: '038 123 4567' },
    { key: 'companyWebsite', labelKey: 'documents.style.website', fallback: 'Website', placeholder: 'vandijk.nl' },
    { key: 'companyChamber', labelKey: 'documents.style.chamber', fallback: 'Chamber of Commerce', placeholder: 'KvK 12345678' },
    { key: 'companyVat', labelKey: 'documents.style.vat', fallback: 'VAT number', placeholder: 'NL001234567B01' },
    { key: 'companyIban', labelKey: 'documents.style.iban', fallback: 'IBAN', placeholder: 'NL12 BEEF 0123 4567 89' },
    { key: 'footerText', labelKey: 'documents.style.footer', fallback: 'Footer line', placeholder: 'Hartelijk dank voor uw vertrouwen.' },
];

const COLOUR_FIELDS = [
    { key: 'accent', labelKey: 'documents.style.accent', fallback: 'Accent', varName: '--doc-accent' },
    { key: 'ink', labelKey: 'documents.style.ink', fallback: 'Text', varName: '--doc-ink' },
    { key: 'muted', labelKey: 'documents.style.muted', fallback: 'Muted text', varName: '--doc-muted' },
];

export default function HouseStylePanel({ onBack }) {
    const { t } = useTranslation();

    const [style, setStyle] = useState(null);
    const [meta, setMeta] = useState({ editable: false, hasOrg: false, fonts: ['sans'], maxLogoBytes: 262144, deck: DECK_FALLBACK });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState('');
    // The presentation preview: the RESOLVED theme for the style as it is
    // being edited (contrast, presets and derived colours are decided on the
    // server, so the picture is exactly what the .pptx will be).
    const [deckTheme, setDeckTheme] = useState(null);
    const [deckThemeLoading, setDeckThemeLoading] = useState(false);
    const previewSeq = useRef(0);

    useEffect(() => {
        let cancelled = false;
        getHouseStyle()
            .then((body) => {
                if (cancelled) return;
                setStyle(body.style);
                setMeta({
                    editable: !!body.editable,
                    hasOrg: !!body.hasOrg,
                    fonts: body.fonts || ['sans'],
                    maxLogoBytes: body.maxLogoBytes || 262144,
                    deck: body.deck && Array.isArray(body.deck.presets) ? body.deck : DECK_FALLBACK,
                });
            })
            .catch((e) => { if (!cancelled) setError(e.message); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, []);

    const set = (key, value) => {
        setStyle((s) => ({ ...s, [key]: value }));
        setSaved(false);
    };
    const setDeck = (key, value) => {
        setStyle((s) => ({ ...s, deck: { ...DEFAULT_DECK, ...(s.deck || {}), [key]: value } }));
        setSaved(false);
    };

    // Re-resolve the preview a moment after the last edit. Sequence-guarded so
    // a slow answer to an old edit never paints over a newer one.
    useEffect(() => {
        if (!style) return undefined;
        const seq = ++previewSeq.current;
        setDeckThemeLoading(true);
        const timer = setTimeout(() => {
            previewDeckTheme(style)
                .then((theme) => { if (seq === previewSeq.current) setDeckTheme(theme); })
                .catch(() => { /* the preview is a courtesy; the form still saves */ })
                .finally(() => { if (seq === previewSeq.current) setDeckThemeLoading(false); });
        }, 250);
        return () => clearTimeout(timer);
    }, [style]);

    const handleLogo = async (file) => {
        if (!file) return;
        setError('');
        // Checked here for a useful message, and again on the server because a
        // client-side check is a courtesy, not a limit.
        if (file.size > meta.maxLogoBytes) {
            setError(t('documents.style.logo_too_large', 'That logo is {size} KB; the limit is {max} KB.')
                .replace('{size}', Math.round(file.size / 1024))
                .replace('{max}', Math.round(meta.maxLogoBytes / 1024)));
            return;
        }
        try {
            set('logoDataUrl', await fileToDataUrl(file));
        } catch (e) {
            setError(e.message);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        setError('');
        try {
            setStyle(await saveHouseStyle(style));
            setSaved(true);
        } catch (e) {
            setError(e.message);
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full">
                <Loader2 className="animate-spin" size={22} style={{ color: 'var(--accent-primary)' }} />
            </div>
        );
    }

    if (!style) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-3">
                <p style={{ color: 'var(--text-muted)' }}>{error || t('documents.style.unavailable', 'The house style could not be loaded.')}</p>
                <button onClick={onBack} className="text-sm underline" style={{ color: 'var(--accent-primary)' }}>
                    {t('documents.back', 'Back to Documents')}
                </button>
            </div>
        );
    }

    const disabled = !meta.editable;

    return (
        <div className="h-full overflow-y-auto" style={{ background: 'var(--bg-primary)' }}>
            <div className="max-w-3xl mx-auto px-6 py-8">
                <div className="flex items-start gap-3 mb-6">
                    <button
                        onClick={onBack}
                        className="p-1.5 rounded-lg hover:opacity-80 shrink-0 mt-0.5"
                        aria-label={t('documents.back', 'Back to Documents')}
                        style={{ color: 'var(--text-muted)' }}
                    >
                        <ArrowLeft size={17} />
                    </button>
                    <div className="flex-1 min-w-0">
                        <h1 className="text-2xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
                            {t('documents.style.title', 'Document house style')}
                        </h1>
                        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                            {t('documents.style.subtitle', 'The letterhead every new document starts from. Any single document can opt out of it.')}
                            {' '}{t('documents.style.subtitle_decks', 'Presentations follow it too, with their own section below — and any presentation can choose its own look.')}
                        </p>
                    </div>
                </div>

                {!meta.hasOrg && (
                    <Notice tone="warn">
                        {t('documents.style.no_org', 'A house style belongs to an organisation, and this account is not in one. Documents will use their own styling.')}
                    </Notice>
                )}
                {meta.hasOrg && disabled && (
                    <Notice tone="info">
                        {t('documents.style.read_only', 'Only an organisation administrator can change the house style. You are seeing what documents will use.')}
                    </Notice>
                )}
                {error && <Notice tone="error">{error}</Notice>}

                {/* ── Master switch ── */}
                <Card>
                    <label className="flex items-start gap-3 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={!!style.enabled}
                            disabled={disabled}
                            onChange={(e) => set('enabled', e.target.checked)}
                            className="mt-1"
                            data-testid="house-style-enabled"
                        />
                        <span>
                            <span className="block text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                                {t('documents.style.enable', 'Use this house style on new documents')}
                            </span>
                            <span className="block text-sm" style={{ color: 'var(--text-muted)' }}>
                                {t('documents.style.enable_hint', 'Off means nothing is applied and every document is whatever its own styling says. This is the default until you fill the letterhead in.')}
                            </span>
                        </span>
                    </label>
                </Card>

                {/* ── Logo ── */}
                <Card title={t('documents.style.logo', 'Logo')}>
                    <p className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>
                        {t('documents.style.logo_hint', 'PNG, JPEG, WebP or SVG. It is embedded in the document, so it also prints when there is no internet.')}
                    </p>
                    <div className="flex items-center gap-4">
                        <div
                            className="w-20 h-20 rounded-lg flex items-center justify-center shrink-0 overflow-hidden"
                            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}
                        >
                            {style.logoDataUrl
                                ? <img src={style.logoDataUrl} alt="" className="max-w-full max-h-full object-contain" data-testid="house-style-logo" />
                                : <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('documents.style.no_logo', 'None')}</span>}
                        </div>
                        <div className="flex flex-col gap-2">
                            <label
                                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
                                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                            >
                                <Upload size={14} />
                                {t('documents.style.upload_logo', 'Choose a file')}
                                <input
                                    type="file"
                                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                                    className="hidden"
                                    disabled={disabled}
                                    onChange={(e) => handleLogo(e.target.files?.[0])}
                                    data-testid="house-style-logo-input"
                                />
                            </label>
                            {style.logoDataUrl && !disabled && (
                                <button
                                    onClick={() => set('logoDataUrl', '')}
                                    className="inline-flex items-center gap-1.5 text-xs"
                                    style={{ color: 'var(--text-muted)' }}
                                >
                                    <Trash2 size={13} />
                                    {t('documents.style.remove_logo', 'Remove')}
                                </button>
                            )}
                        </div>
                        <label className="ml-auto text-xs" style={{ color: 'var(--text-muted)' }}>
                            {t('documents.style.logo_width', 'Width (mm)')}
                            <input
                                type="number"
                                min={6}
                                max={80}
                                value={style.logoWidthMm}
                                disabled={disabled}
                                onChange={(e) => set('logoWidthMm', Number(e.target.value))}
                                className="block w-20 mt-1 px-2 py-1 rounded text-sm"
                                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
                            />
                        </label>
                    </div>
                </Card>

                {/* ── Colours + font ── */}
                <Card title={t('documents.style.look', 'Colours and type')}>
                    <p className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>
                        {t('documents.style.look_hint', 'The assistant writes these as variables, so changing one restyles every document that uses the house style — including ones written months ago.')}
                    </p>
                    <div className="flex flex-wrap gap-4">
                        {COLOUR_FIELDS.map((f) => (
                            <label key={f.key} className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                {t(f.labelKey, f.fallback)}
                                <span className="block font-mono text-[10px] mb-1" style={{ color: 'var(--text-tertiary)' }}>
                                    {f.varName}
                                </span>
                                <span className="flex items-center gap-2">
                                    <input
                                        type="color"
                                        value={style[f.key]}
                                        disabled={disabled}
                                        onChange={(e) => set(f.key, e.target.value)}
                                        className="w-9 h-9 rounded cursor-pointer"
                                        aria-label={t(f.labelKey, f.fallback)}
                                    />
                                    <input
                                        type="text"
                                        value={style[f.key]}
                                        disabled={disabled}
                                        onChange={(e) => set(f.key, e.target.value)}
                                        className="w-24 px-2 py-1 rounded text-sm font-mono"
                                        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
                                    />
                                </span>
                            </label>
                        ))}
                        <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            {t('documents.style.font', 'Typeface')}
                            <span className="block font-mono text-[10px] mb-1" style={{ color: 'var(--text-tertiary)' }}>--doc-font</span>
                            <select
                                value={style.font}
                                disabled={disabled}
                                onChange={(e) => set('font', e.target.value)}
                                className="px-2 py-2 rounded text-sm"
                                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
                            >
                                {meta.fonts.map((f) => (
                                    <option key={f} value={f}>{t(`documents.style.font_${f}`, f)}</option>
                                ))}
                            </select>
                        </label>
                    </div>
                </Card>

                {/* ── Presentations ── */}
                <Card title={t('documents.style.deck', 'Presentations')}>
                    <p className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>
                        {t('documents.style.deck_hint', 'How a deck the assistant or an automation builds looks. Text colours are always kept readable, whatever the letterhead ink is. Every choice can be overridden on a single deck.')}
                    </p>
                    <div className="mb-4" data-testid="house-style-deck-preview">
                        <DeckPreview theme={deckTheme} loading={deckThemeLoading} />
                    </div>
                    <DeckLookFields deck={style.deck} style={style} setDeck={setDeck} set={set} disabled={disabled} options={meta.deck} t={t} mode="house" />
                </Card>

                {/* ── Company details ── */}
                <Card title={t('documents.style.details', 'Company details')}>
                    <p className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>
                        {t('documents.style.details_hint', 'The assistant writes these into the document itself, so you can still correct them by hand on a single invoice.')}
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                        {TEXT_FIELDS.map((f) => (
                            <label key={f.key} className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                {t(f.labelKey, f.fallback)}
                                <input
                                    type="text"
                                    value={style[f.key] || ''}
                                    placeholder={f.placeholder}
                                    disabled={disabled}
                                    onChange={(e) => set(f.key, e.target.value)}
                                    className="block w-full mt-1 px-2 py-1.5 rounded text-sm"
                                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
                                />
                            </label>
                        ))}
                    </div>
                </Card>

                {!disabled && (
                    <div className="flex items-center gap-3 mt-6">
                        <button
                            onClick={handleSave}
                            disabled={saving}
                            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-60"
                            style={{ background: 'var(--accent-primary)', color: '#fff' }}
                            data-testid="house-style-save"
                        >
                            {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                            {t('documents.style.save', 'Save house style')}
                        </button>
                        {saved && (
                            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                                {t('documents.style.saved', 'Saved. New documents will use it.')}
                            </span>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

function Card({ title, children }) {
    return (
        <section
            className="rounded-xl p-5 mb-4"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
        >
            {title && (
                <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>{title}</h2>
            )}
            {children}
        </section>
    );
}

function Notice({ tone, children }) {
    const bg = tone === 'error' ? 'rgba(220,38,38,.08)'
        : tone === 'warn' ? 'rgba(234,179,8,.10)'
            : 'rgba(59,130,246,.08)';
    return (
        <div
            className="flex items-start gap-2 px-3 py-2 rounded-lg mb-4 text-sm"
            style={{ background: bg, color: 'var(--text-primary)' }}
            role={tone === 'error' ? 'alert' : 'status'}
        >
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{children}</span>
        </div>
    );
}
