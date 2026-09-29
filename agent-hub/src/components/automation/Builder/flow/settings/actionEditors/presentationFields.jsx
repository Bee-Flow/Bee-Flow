// The presentation editor: slides in, a PowerPoint or PDF deck out — the
// slide source, the file, and the deck's look.
import { Plus, Trash2 } from 'lucide-react';
import TemplateField from '../../../mapping/TemplateField';
import AccordionSection from '../../AccordionSection';
import { FormRow, inputClass } from '../formPrimitives';

const DECK_FONT_OPTIONS = ['Calibri', 'Arial', 'Helvetica', 'Verdana', 'Segoe UI', 'Trebuchet MS', 'Century Gothic', 'Georgia', 'Cambria', 'Times New Roman', 'Garamond', 'Consolas'];

/** A colour swatch beside a template field: pick a hex, or bind a value from an earlier step. */
function ColourTemplateRow({ value, onChange, onFocusField, previewSample, placeholder, ariaLabel, fallback = '#123a5e' }) {
    return (
        <div className="flex items-center gap-2">
            <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(value || '') ? value : fallback}
                onChange={(e) => onChange(e.target.value)}
                className="w-9 h-9 rounded cursor-pointer shrink-0"
                aria-label={ariaLabel}
            />
            <div className="flex-1">
                <TemplateField value={value || ''} onChange={onChange} rows={1} onFocusField={onFocusField} previewSample={previewSample} placeholder={placeholder} />
            </div>
        </div>
    );
}

/**
 * Presentation — slides in, a PowerPoint (or PDF deck) out.
 *
 * `slides` is the one field that matters, and it has two faces: ONE source
 * (a template — the outline an AI step wrote, or a loop's results) or a LIST
 * of slide references. The toggle only changes how the field is edited; both
 * save into the same `slides` and the runner reads either.
 */
function PresentationFields({ draft, set, onFocusField, previewSample, errorSections = new Set() }) {
    const mode = draft.slidesMode === 'list' ? 'list' : 'source';
    const rows = Array.isArray(draft.slideRows) ? draft.slideRows : [];
    const days = Number.isFinite(Number(draft.expiresInDays)) ? Number(draft.expiresInDays) : 7;
    const setRows = (next) => set('slideRows', next);

    return (
        <>
            <AccordionSection stepType="presentation" sectionKey="slides" title="Slides" defaultOpen forceOpen={errorSections.has('slides')}>
                <div className="flex items-center gap-2 mb-2 text-xs">
                    <button type="button" onClick={() => set('slidesMode', 'source')}
                        className={`px-2 py-1 rounded border ${mode === 'source' ? 'bg-[var(--surface-2)] border-[var(--border-default)]' : 'border-transparent text-[var(--text-secondary)]'}`}>
                        One source
                    </button>
                    <button type="button" onClick={() => set('slidesMode', 'list')}
                        className={`px-2 py-1 rounded border ${mode === 'list' ? 'bg-[var(--surface-2)] border-[var(--border-default)]' : 'border-transparent text-[var(--text-secondary)]'}`}>
                        Pick slides
                    </button>
                </div>
                {mode === 'source' ? (
                    <FormRow label="Slides from" required hint={'The outline an AI step wrote ("# " title, "## " per slide, "- " bullets), or the results of a Slide step that runs once per item.'}>
                        <TemplateField
                            value={draft.slides || ''}
                            onChange={(next) => set('slides', next)}
                            rows={2}
                            onFocusField={onFocusField}
                            previewSample={previewSample}
                            placeholder="{{steps.ai_1.output.text}}"
                        />
                    </FormRow>
                ) : (
                    <FormRow label="Slides" required hint="One Slide step per row, in order. Each row is a whole reference to that step's slide.">
                        <div className="space-y-2">
                            {rows.map((row, i) => (
                                <div key={i} className="flex items-start gap-2">
                                    <div className="flex-1">
                                        <TemplateField
                                            value={row || ''}
                                            onChange={(next) => setRows(rows.map((r, j) => (j === i ? next : r)))}
                                            rows={1}
                                            onFocusField={onFocusField}
                                            previewSample={previewSample}
                                            placeholder="{{steps.slide_1.output.slide}}"
                                        />
                                    </div>
                                    <button type="button" aria-label="Remove slide" onClick={() => setRows(rows.filter((_, j) => j !== i))}
                                        className="mt-1 p-1 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            ))}
                            <button type="button" onClick={() => setRows([...rows, ''])}
                                className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                                <Plus size={14} /> Add a slide
                            </button>
                        </div>
                    </FormRow>
                )}
            </AccordionSection>

            <AccordionSection stepType="presentation" sectionKey="output" title="The file" defaultOpen forceOpen={errorSections.has('output')}>
                <FormRow label="Format" required>
                    <select value={draft.format === 'pdf' ? 'pdf' : 'pptx'} onChange={(e) => set('format', e.target.value)} className={inputClass()}>
                        <option value="pptx">PowerPoint (.pptx)</option>
                        <option value="pdf">PDF deck</option>
                    </select>
                </FormRow>
                <FormRow label="Title" hint="The cover title, and the filename when you leave that blank. Falls back to the outline's own title.">
                    <TemplateField
                        value={draft.title || ''}
                        onChange={(next) => set('title', next)}
                        rows={1}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder="Kwartaalcijfers {{trigger.output.kwartaal}}"
                    />
                </FormRow>
                <FormRow label="Subtitle" hint="On the cover: audience, date, author.">
                    <TemplateField
                        value={draft.subtitle || ''}
                        onChange={(next) => set('subtitle', next)}
                        rows={1}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                    />
                </FormRow>
                <FormRow label="Filename" hint="Without the extension — that follows from the format.">
                    <TemplateField
                        value={draft.fileName || ''}
                        onChange={(next) => set('fileName', next)}
                        rows={1}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder="kwartaalcijfers-{{trigger.output.kwartaal}}"
                    />
                </FormRow>
            </AccordionSection>

            <AccordionSection stepType="presentation" sectionKey="options" title="Look" defaultOpen={!!(draft.preset || draft.accent || draft.font || draft.coverStyle || draft.tableStyle || draft.logo || draft.logoPlacement)} forceOpen={errorSections.has('options')} hasContent={!!(draft.preset || draft.accent || draft.background || draft.font || draft.titleFont || draft.coverStyle || draft.tableStyle || draft.logo || draft.logoPlacement || draft.footerText || draft.slideNumbers || draft.template || draft.houseStyle === false)}>
                <FormRow label="House style" hint="Your organisation's colours, font, logo and footer — set under Studio → Documents → House style. Switch off only for a deck in someone else's branding.">
                    <label className="inline-flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={draft.houseStyle !== false} onChange={(e) => set('houseStyle', e.target.checked)} />
                        <span>Use the house style</span>
                    </label>
                </FormRow>
                <FormRow label="Style" hint="Leave on “house style” to follow the organisation's choice; pick one to override it for this deck.">
                    <select value={draft.preset || ''} onChange={(e) => set('preset', e.target.value)} className={inputClass()}>
                        <option value="">House style</option>
                        <option value="band">Title band — white slides, coloured title band</option>
                        <option value="clean">Clean — white slides, accent titles</option>
                        <option value="bold">Bold — accent-coloured slides</option>
                        <option value="dark">Dark — charcoal slides</option>
                    </select>
                </FormRow>
                <FormRow label="Accent colour" hint="#RRGGBB, or a value from an earlier step. Blank = the house style's accent.">
                    <ColourTemplateRow value={draft.accent} onChange={(next) => set('accent', next)} onFocusField={onFocusField} previewSample={previewSample} placeholder="#1A73E8" ariaLabel="Accent colour" />
                </FormRow>
                <FormRow label="Typeface">
                    <select value={draft.font || ''} onChange={(e) => set('font', e.target.value)} className={inputClass()}>
                        <option value="">House style</option>
                        {DECK_FONT_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                </FormRow>
                <FormRow label="Logo" hint={'The image URL a Generate image step produced, a data: URL, or "none" to leave the house-style logo off. Blank = the house-style logo.'}>
                    <TemplateField
                        value={draft.logo || ''}
                        onChange={(next) => set('logo', next)}
                        rows={1}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder="{{steps.image_1.output.imageUrl}} — or: none"
                    />
                </FormRow>
                <FormRow label="Logo placement">
                    <select value={draft.logoPlacement || ''} onChange={(e) => set('logoPlacement', e.target.value)} className={inputClass()} data-testid="presentation-logo-placement">
                        <option value="">House style</option>
                        <option value="footer">Footer</option>
                        <option value="corner">Top corner</option>
                        <option value="cover">Cover only</option>
                        <option value="none">Nowhere</option>
                    </select>
                </FormRow>
                <FormRow label="Cover">
                    <select value={draft.coverStyle || ''} onChange={(e) => set('coverStyle', e.target.value)} className={inputClass()}>
                        <option value="">House style</option>
                        <option value="accent">Accent block</option>
                        <option value="light">Light</option>
                        <option value="split">Split panel</option>
                    </select>
                </FormRow>
                <FormRow label="Tables">
                    <select value={draft.tableStyle || ''} onChange={(e) => set('tableStyle', e.target.value)} className={inputClass()}>
                        <option value="">House style</option>
                        <option value="banded">Banded rows</option>
                        <option value="lines">Lines</option>
                        <option value="minimal">Minimal</option>
                    </select>
                </FormRow>
                <details className="mt-1" open={!!(draft.background || draft.titleFont || draft.footerText || draft.slideNumbers || draft.template)}>
                    <summary className="text-xs cursor-pointer text-[var(--text-secondary)] select-none">More look options</summary>
                    <div className="mt-2 space-y-2">
                        <FormRow label="Background" hint="#RRGGBB or a value from an earlier step; text colours adapt so they stay readable.">
                            <ColourTemplateRow value={draft.background} onChange={(next) => set('background', next)} onFocusField={onFocusField} previewSample={previewSample} placeholder="#FFFFFF" ariaLabel="Background colour" fallback="#ffffff" />
                        </FormRow>
                        <FormRow label="Title typeface">
                            <select value={draft.titleFont || ''} onChange={(e) => set('titleFont', e.target.value)} className={inputClass()}>
                                <option value="">Same as the body</option>
                                {DECK_FONT_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
                            </select>
                        </FormRow>
                        <FormRow label="Footer line" hint="Shown small on every slide, e.g. “Vertrouwelijk · Q3 2026”. Blank = the house-style footer.">
                            <TemplateField value={draft.footerText || ''} onChange={(next) => set('footerText', next)} rows={1} onFocusField={onFocusField} previewSample={previewSample} placeholder="Vertrouwelijk · {{trigger.output.date}}" />
                        </FormRow>
                        <FormRow label="Slide numbers">
                            <select value={draft.slideNumbers || ''} onChange={(e) => set('slideNumbers', e.target.value)} className={inputClass()} data-testid="presentation-slide-numbers">
                                <option value="">House style</option>
                                <option value="true">Shown</option>
                                <option value="false">Hidden</option>
                            </select>
                        </FormRow>
                        <FormRow label="Template deck" hint="The .pptx uploaded under House style → Presentations paints its backgrounds and logo under every slide. Choose plain slides to build without it.">
                            <select value={draft.template || ''} onChange={(e) => set('template', e.target.value)} className={inputClass()} data-testid="presentation-template">
                                <option value="">House style (template when uploaded)</option>
                                <option value="none">Plain slides — no template</option>
                            </select>
                        </FormRow>
                    </div>
                </details>
                <FormRow label="Also keep it in Documents" hint="Keeps the deck in Studio → Documents as a presentation you can open in Bee Flow, edit and rebuild. Leave it off for a routine that runs often — it makes a document every run.">
                    <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                        <input type="checkbox" checked={draft.saveCopy === true} onChange={(e) => set('saveCopy', e.target.checked)} data-testid="presentation-save-copy" />
                        Keep a copy
                    </label>
                </FormRow>
                {draft.saveCopy === true && (
                    <FormRow label="Name of the copy" hint="Defaults to the title plus today's date.">
                        <TemplateField
                            value={draft.copyName || ''}
                            onChange={(next) => set('copyName', next)}
                            rows={1}
                            onFocusField={onFocusField}
                            previewSample={previewSample}
                            placeholder="Kwartaalcijfers {{trigger.date}}"
                        />
                    </FormRow>
                )}
                <FormRow label="Keep for" required hint="How long the download keeps working. The file is deleted afterwards — save it to Nextcloud as well if it has to be kept.">
                    <div className="flex items-center gap-2">
                        <input
                            type="number"
                            min={1}
                            max={90}
                            value={days}
                            onChange={(e) => {
                                const n = Number(e.target.value);
                                if (Number.isFinite(n)) set('expiresInDays', Math.min(90, Math.max(1, Math.round(n))));
                            }}
                            className={inputClass()}
                        />
                        <span className="text-xs text-[var(--text-secondary)] whitespace-nowrap">days</span>
                    </div>
                </FormRow>
            </AccordionSection>
        </>
    );
}

export { PresentationFields };
