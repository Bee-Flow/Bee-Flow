import React, { useState } from 'react';
import { fileToDataUrl, uploadDeckTemplate } from './documentsApi';

/**
 * The look of a presentation, as a form — ONE form for two owners.
 *
 * The house-style panel edits the organisation's deck style (`style.deck`);
 * the presentation editor edits one document's overrides (`settings.deck`).
 * Both speak the same vocabulary (server: core/documents/deckThemeOptions.js),
 * with one difference in meaning: on a document an unset key means "as the
 * house style has it", so `mode="document"` offers that as a choice on every
 * control, and lets the document bring its own logo or template deck.
 *
 * Nothing is resolved here. Contrast, presets and derived colours are decided
 * on the server, which is why the caller draws the preview from a server
 * answer (previewDeckTheme / previewDeckDraft) rather than from these values.
 */

// Shown when the server did not send a catalog (an older API): the same ids
// deckThemeOptions.js owns, so the selects never offer a value it refuses.
export const DECK_FALLBACK = {
    presets: [
        { id: 'band', label: 'Title band', description: 'White slides with the title in a coloured band across the top.' },
        { id: 'clean', label: 'Clean', description: 'White slides, the title in the accent colour with a thin rule under it.' },
        { id: 'bold', label: 'Bold', description: 'Every slide in the accent colour, white titles and text.' },
        { id: 'dark', label: 'Dark', description: 'Charcoal slides, titles in the accent colour, light text.' },
    ],
    fonts: ['Calibri', 'Arial', 'Helvetica', 'Verdana', 'Segoe UI', 'Trebuchet MS', 'Century Gothic', 'Georgia', 'Cambria', 'Times New Roman', 'Garamond', 'Consolas'],
    coverStyles: [{ id: 'accent', label: 'Accent block' }, { id: 'light', label: 'Light' }, { id: 'split', label: 'Split' }],
    tableStyles: [{ id: 'banded', label: 'Banded' }, { id: 'lines', label: 'Lines' }, { id: 'minimal', label: 'Minimal' }],
    logoPlacements: [{ id: 'footer', label: 'Footer' }, { id: 'corner', label: 'Top corner' }, { id: 'cover', label: 'Cover only' }, { id: 'none', label: 'Nowhere' }],
};
export const DEFAULT_DECK = { preset: 'band', accent: '', background: '', text: '', titleFont: '', bodyFont: '', coverStyle: 'accent', tableStyle: 'banded', logoPlacement: 'footer', slideNumbers: true, brandOnSlides: true, footerText: '' };

const MAX_LOGO_BYTES = 256 * 1024;
const fieldStyle = { background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' };
/** A pill in a radio row: outlined, or filled and accent-bordered when chosen. */
const choice = (active) => ({ background: active ? 'var(--bg-tertiary)' : 'transparent', border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-subtle)'}`, color: 'var(--text-primary)' });

/** An optional colour: a tick for "own choice", a picker when ticked, "house style" when not. */
export function OptionalColour({ label, value, fallback, disabled, onChange, testId }) {
    const own = !!value;
    return (
        <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {label}
            <span className="flex items-center gap-2 mt-1">
                <input type="checkbox" checked={own} disabled={disabled} onChange={(e) => onChange(e.target.checked ? (fallback || '#123a5e') : '')} aria-label={`${label} own colour`} data-testid={testId ? `${testId}-own` : undefined} />
                <input type="color" value={own ? value : (fallback || '#ffffff')} disabled={disabled || !own} onChange={(e) => onChange(e.target.value)} className="w-9 h-9 rounded cursor-pointer" aria-label={label} data-testid={testId} />
                <input type="text" value={own ? value : ''} placeholder="house style" disabled={disabled || !own} onChange={(e) => onChange(e.target.value)} className="w-24 px-2 py-1 rounded text-sm font-mono" style={fieldStyle} />
            </span>
        </label>
    );
}

/** The house-style changes a freshly read template deck suggests: its brand colour and typefaces. */
export function templateSuggestions(template, style) {
    if (!template) return [];
    const out = [];
    const accent = (template.accent || '').toUpperCase();
    if (accent && accent !== String(style.accent || '').toUpperCase()) out.push({ key: 'accent', value: accent });
    const body = template.fonts && template.fonts.body;
    const family = body ? (/cambria|georgia|times|garamond/i.test(body) ? 'serif' : (/consolas/i.test(body) ? 'mono' : 'sans')) : '';
    if (family && family !== style.font) out.push({ key: 'font', value: family, label: body });
    const title = template.fonts && template.fonts.title;
    if (title && title !== (style.deck && style.deck.titleFont)) out.push({ key: 'deck.titleFont', value: title });
    if (body && body !== (style.deck && style.deck.bodyFont)) out.push({ key: 'deck.bodyFont', value: body });
    return out;
}

/**
 * @param {object} props.deck        the deck style (house) or overrides (document); missing keys = inherit
 * @param {Function} props.setDeck   (key, value) => void; '' / undefined = inherit
 * @param {object} props.style       the house style, for fallbacks and (house mode) the suggestions
 * @param {Function} [props.set]     house mode only: (key, value) on the house style itself
 * @param {'house'|'document'} [props.mode]
 * @param {string} [props.testPrefix]  data-testid prefix (house-style-deck | document-deck)
 */
export default function DeckLookFields({ deck: deckIn, setDeck, style = {}, set = null, disabled = false, options, t, mode = 'house', testPrefix = 'house-style-deck' }) {
    const isDoc = mode === 'document';
    const deck = isDoc ? { ...(deckIn || {}) } : { ...DEFAULT_DECK, ...(deckIn || {}) };
    const opt = options || DECK_FALLBACK;
    const [templateBusy, setTemplateBusy] = useState(false);
    const [templateError, setTemplateError] = useState('');
    const [logoError, setLogoError] = useState('');
    const [suggestFor, setSuggestFor] = useState(null);
    const suggestions = !isDoc && set && suggestFor && deck.template && deck.template.content && suggestFor === deck.template.content.image ? templateSuggestions(deck.template, style) : [];
    const applySuggestions = () => {
        for (const sug of suggestions) {
            if (sug.key.startsWith('deck.')) setDeck(sug.key.slice(5), sug.value);
            else if (set) set(sug.key, sug.value);
        }
        setSuggestFor(null);
    };
    const onTemplateFile = async (file) => {
        if (!file) return;
        setTemplateBusy(true);
        setTemplateError('');
        try {
            const template = await uploadDeckTemplate(await fileToDataUrl(file), file.name);
            setDeck('template', template);
            setSuggestFor(template && template.content ? template.content.image : null);
        } catch (e) {
            setTemplateError(e.message || 'Failed to read the template deck');
        } finally {
            setTemplateBusy(false);
        }
    };
    const onLogoFile = async (file) => {
        if (!file) return;
        setLogoError('');
        if (file.size > MAX_LOGO_BYTES) {
            setLogoError(t('documents.style.logo_too_large', 'That logo is {size} KB; the limit is {max} KB.').replace('{size}', Math.round(file.size / 1024)).replace('{max}', Math.round(MAX_LOGO_BYTES / 1024)));
            return;
        }
        try { setDeck('logo', await fileToDataUrl(file)); } catch (e) { setLogoError(e.message); }
    };
    const select = (key, list, labelKey, fallback, { allowInherit = false } = {}) => (
        <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {t(labelKey, fallback)}
            <select
                value={deck[key] || ''}
                disabled={disabled}
                onChange={(e) => setDeck(key, e.target.value)}
                className="block w-full mt-1 px-2 py-2 rounded text-sm"
                style={fieldStyle}
                data-testid={`${testPrefix}-${key}`}
            >
                {(allowInherit || isDoc) && <option value="">{isDoc ? t('documents.style.deck_as_house', 'House style') : t('documents.style.deck_inherit', 'Same as documents')}</option>}
                {list.map((o) => (typeof o === 'string'
                    ? <option key={o} value={o}>{o}</option>
                    : <option key={o.id} value={o.id}>{o.label}</option>))}
            </select>
        </label>
    );
    // On a document a switch has three states: as the house style, on, off.
    const triState = (key, labelKey, fallback) => (
        isDoc ? (
            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {t(labelKey, fallback)}
                <select value={deck[key] === undefined || deck[key] === '' ? '' : (deck[key] === false ? 'off' : 'on')} disabled={disabled} onChange={(e) => setDeck(key, e.target.value === '' ? undefined : e.target.value === 'on')} className="block w-full mt-1 px-2 py-2 rounded text-sm" style={fieldStyle} data-testid={`${testPrefix}-${key}`}>
                    <option value="">{t('documents.style.deck_as_house', 'House style')}</option>
                    <option value="on">{t('documents.style.deck_on', 'On')}</option>
                    <option value="off">{t('documents.style.deck_off', 'Off')}</option>
                </select>
            </label>
        ) : (
            <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={deck[key] !== false} disabled={disabled} onChange={(e) => setDeck(key, e.target.checked)} data-testid={key === 'slideNumbers' ? `${testPrefix}-numbers` : undefined} />
                {t(labelKey, fallback)}
            </label>
        )
    );
    const logoMode = !isDoc ? null : (deck.logo === 'none' ? 'none' : (deck.logo ? 'own' : 'house'));
    const templateMode = !isDoc ? null : (deck.template === 'none' ? 'none' : (deck.template && typeof deck.template === 'object' ? 'own' : 'house'));
    return (
        <div className="space-y-4">
            <div>
                <div className="text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>{t('documents.style.deck_preset', 'Style')}</div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2" role="radiogroup" aria-label={t('documents.style.deck_preset', 'Style')}>
                    {[...(isDoc ? [{ id: '', label: t('documents.style.deck_as_house', 'House style'), description: t('documents.style.deck_inherit_preset', 'The style the organisation chose.') }] : []), ...opt.presets].map((p) => {
                        const active = (deck.preset || '') === p.id;
                        return (
                            <button
                                key={p.id || 'inherit'}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                disabled={disabled}
                                onClick={() => setDeck('preset', p.id)}
                                className="text-left rounded-lg p-2.5 text-xs disabled:opacity-60"
                                style={{ background: active ? 'var(--bg-tertiary)' : 'transparent', border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-subtle)'}`, color: 'var(--text-primary)' }}
                                data-testid={`${testPrefix}-preset-${p.id || 'inherit'}`}
                            >
                                <span className="block font-semibold">{p.label}</span>
                                <span className="block mt-0.5" style={{ color: 'var(--text-muted)' }}>{p.description}</span>
                            </button>
                        );
                    })}
                </div>
            </div>
            <div className="flex flex-wrap gap-4">
                <OptionalColour label={t('documents.style.deck_accent', 'Accent')} value={deck.accent} fallback={(style.deck && style.deck.accent) || style.accent} disabled={disabled} onChange={(v) => setDeck('accent', v)} testId={`${testPrefix}-accent`} />
                <OptionalColour label={t('documents.style.deck_background', 'Slide background')} value={deck.background} fallback={(style.deck && style.deck.background) || '#ffffff'} disabled={disabled} onChange={(v) => setDeck('background', v)} />
                <OptionalColour label={t('documents.style.deck_text', 'Text')} value={deck.text} fallback={(style.deck && style.deck.text) || '#1a1d21'} disabled={disabled} onChange={(v) => setDeck('text', v)} />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {select('titleFont', opt.fonts, 'documents.style.deck_title_font', 'Title typeface', { allowInherit: true })}
                {select('bodyFont', opt.fonts, 'documents.style.deck_body_font', 'Body typeface', { allowInherit: true })}
                {select('coverStyle', opt.coverStyles, 'documents.style.deck_cover', 'Cover')}
                {select('tableStyle', opt.tableStyles, 'documents.style.deck_table', 'Tables')}
                {select('logoPlacement', opt.logoPlacements, 'documents.style.deck_logo', 'Logo')}
                <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {t('documents.style.deck_footer', 'Footer line on slides')}
                    <input
                        type="text"
                        value={deck.footerText || ''}
                        placeholder={(style.deck && style.deck.footerText) || style.footerText || style.companyName || ''}
                        disabled={disabled}
                        onChange={(e) => setDeck('footerText', e.target.value)}
                        className="block w-full mt-1 px-2 py-1.5 rounded text-sm"
                        style={fieldStyle}
                        data-testid={`${testPrefix}-footer`}
                    />
                </label>
            </div>
            {isDoc && (
                <div>
                    <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{t('documents.style.deck_logo_source', 'Logo on this presentation')}</div>
                    <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={t('documents.style.deck_logo_source', 'Logo on this presentation')}>
                        {[['house', t('documents.style.deck_logo_house', 'House-style logo')], ['none', t('documents.style.deck_logo_none', 'No logo')]].map(([id, label]) => (
                            <button key={id} type="button" role="radio" aria-checked={logoMode === id} disabled={disabled} data-testid={`${testPrefix}-logo-${id}`}
                                onClick={() => setDeck('logo', id === 'house' ? undefined : 'none')}
                                className="px-3 py-1.5 rounded-lg text-xs" style={choice(logoMode === id)}>
                                {label}
                            </button>
                        ))}
                        <label role="radio" aria-checked={logoMode === 'own'} className={`px-3 py-1.5 rounded-lg text-xs ${disabled ? 'opacity-60' : 'cursor-pointer'}`} style={choice(logoMode === 'own')} data-testid={`${testPrefix}-logo-own`}>
                            {t('documents.style.deck_logo_own', 'Own logo')}
                            <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" disabled={disabled} onChange={(e) => onLogoFile(e.target.files && e.target.files[0])} data-testid={`${testPrefix}-logo-file`} />
                        </label>
                        {logoMode === 'own' && <img src={deck.logo} alt="" className="h-8 max-w-24 object-contain rounded" style={{ background: 'var(--bg-tertiary)' }} data-testid={`${testPrefix}-logo-preview`} />}
                    </div>
                    {logoError && <p className="text-xs mt-1" style={{ color: 'var(--danger, #b91c1c)' }}>{logoError}</p>}
                </div>
            )}
            <div>
                <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{t('documents.style.deck_template', 'Template deck (.pptx)')}</div>
                <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>{t('documents.style.deck_template_hint', 'Upload a deck whose first two slides carry the design (a cover and a content slide): its backgrounds and logo go under every presentation, and the style above steps back.')}</p>
                {isDoc && (
                    <div className="flex flex-wrap items-center gap-2 mb-2" role="radiogroup" aria-label={t('documents.style.deck_template', 'Template deck (.pptx)')}>
                        {[['house', t('documents.style.deck_template_house', 'As the house style')], ['none', t('documents.style.deck_template_none', 'Plain slides')]].map(([id, label]) => (
                            <button key={id} type="button" role="radio" aria-checked={templateMode === id} disabled={disabled} data-testid={`${testPrefix}-template-${id}`}
                                onClick={() => setDeck('template', id === 'house' ? undefined : 'none')}
                                className="px-3 py-1.5 rounded-lg text-xs" style={choice(templateMode === id)}>
                                {label}
                            </button>
                        ))}
                        <label role="radio" aria-checked={templateMode === 'own'} className={`px-3 py-1.5 rounded-lg text-xs ${disabled || templateBusy ? 'opacity-60' : 'cursor-pointer'}`} style={choice(templateMode === 'own')} data-testid={`${testPrefix}-template-own`}>
                            {templateBusy ? t('documents.style.deck_template_reading', 'Reading…') : t('documents.style.deck_template_own', 'Own template deck')}
                            <input type="file" accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" disabled={disabled || templateBusy} className="hidden" onChange={(e) => onTemplateFile(e.target.files && e.target.files[0])} data-testid={`${testPrefix}-template-file`} />
                        </label>
                    </div>
                )}
                {deck.template && typeof deck.template === 'object' ? (
                    <div className="flex items-center gap-3 text-sm" data-testid={`${testPrefix}-template`}>
                        <span className="truncate" style={{ color: 'var(--text-primary)' }}>{deck.template.name || t('documents.style.deck_template_unnamed', 'Template deck')}</span>
                        {!disabled && (
                            <button type="button" className="text-xs underline" style={{ color: 'var(--text-muted)' }} onClick={() => setDeck('template', isDoc ? undefined : null)} data-testid={`${testPrefix}-template-remove`}>
                                {t('documents.style.deck_template_remove', 'Remove')}
                            </button>
                        )}
                    </div>
                ) : (!isDoc && (
                    <label className="inline-flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--text-primary)' }}>
                        <input type="file" accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" disabled={disabled || templateBusy} className="hidden" onChange={(e) => onTemplateFile(e.target.files && e.target.files[0])} data-testid={`${testPrefix}-template-file`} />
                        <span className="px-3 py-1.5 rounded border text-xs" style={{ borderColor: 'var(--border-default)' }}>{templateBusy ? t('documents.style.deck_template_reading', 'Reading…') : t('documents.style.deck_template_upload', 'Upload a .pptx')}</span>
                    </label>
                ))}
                {templateError && <p className="text-xs mt-1" style={{ color: 'var(--danger, #b91c1c)' }} data-testid={`${testPrefix}-template-error`}>{templateError}</p>}
                {suggestions.length > 0 && !disabled && (
                    <div className="mt-3 p-3 rounded-md text-sm" style={{ background: 'var(--bg-tertiary)' }} data-testid="house-style-template-suggestions">
                        <div className="font-medium mb-1" style={{ color: 'var(--text-primary)' }}>{t('documents.style.deck_template_suggest', 'Match the house style to this template?')}</div>
                        <ul className="text-xs space-y-1 mb-2" style={{ color: 'var(--text-muted)' }}>
                            {suggestions.map((sug) => (
                                <li key={sug.key} className="flex items-center gap-2">
                                    {sug.key === 'accent' && <span className="inline-block w-3.5 h-3.5 rounded-sm border" style={{ background: sug.value, borderColor: 'var(--border-default)' }} />}
                                    <span>
                                        {sug.key === 'accent' && `${t('documents.style.accent', 'Accent')}: ${sug.value}`}
                                        {sug.key === 'font' && `${t('documents.style.font', 'Typeface')}: ${sug.label}`}
                                        {sug.key === 'deck.titleFont' && `${t('documents.style.deck_title_font', 'Title typeface')}: ${sug.value}`}
                                        {sug.key === 'deck.bodyFont' && `${t('documents.style.deck_body_font', 'Body typeface')}: ${sug.value}`}
                                    </span>
                                </li>
                            ))}
                        </ul>
                        <div className="flex gap-2">
                            <button type="button" className="px-3 py-1 rounded text-xs text-white" style={{ background: 'var(--accent-primary, #123a5e)' }} onClick={applySuggestions} data-testid="house-style-template-apply">{t('documents.style.deck_template_apply', 'Apply')}</button>
                            <button type="button" className="px-3 py-1 rounded text-xs border" style={{ borderColor: 'var(--border-default)' }} onClick={() => setSuggestFor(null)}>{t('documents.style.deck_template_keep', 'Keep mine')}</button>
                        </div>
                    </div>
                )}
            </div>
            <div className={`flex flex-wrap gap-5 text-sm${isDoc ? ' grid grid-cols-2' : ''}`} style={{ color: 'var(--text-primary)' }}>
                {triState('slideNumbers', 'documents.style.deck_numbers', 'Slide numbers')}
                {triState('brandOnSlides', 'documents.style.deck_brand', 'Company name on every slide')}
            </div>
        </div>
    );
}
