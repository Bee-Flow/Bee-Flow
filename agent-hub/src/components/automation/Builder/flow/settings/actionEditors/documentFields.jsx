// The two document steps: make a PDF or Word file out of an upstream step's
// text, and fill a document designed in Studio placeholder by placeholder.
import { useEffect, useMemo, useState } from 'react';
import { listTemplates, documentRequest } from '../../../../../../pages/documents/documentsApi';
import TemplateField from '../../../mapping/TemplateField';
import AccordionSection from '../../AccordionSection';
import { AMBER_NOTE, cardClass, FormRow, hintTextClass, inputClass } from '../formPrimitives';

/**
 * Make a document — PDF or Word from an upstream step's text.
 *
 * `content` is the only field that matters and the only one the author cannot
 * guess: it is a template, almost always a single reference to the step that
 * wrote the text. Everything else has a working default, so a dropped node is
 * one click away from producing something.
 */
function GenerateDocumentFields({ draft, set, onFocusField, previewSample, errorSections = new Set() }) {
    const format = draft.format === 'docx' ? 'docx' : 'pdf';
    const days = Number.isFinite(Number(draft.expiresInDays)) ? Number(draft.expiresInDays) : 7;

    return (
        <>
            <AccordionSection stepType="generate_document" sectionKey="content" title="Content" defaultOpen forceOpen={errorSections.has('content')}>
                <FormRow label="Text" required hint="Click a value in the right panel to insert it — usually the step that wrote the text.">
                    <TemplateField
                        value={draft.content || ''}
                        onChange={(next) => set('content', next)}
                        rows={3}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder="{{steps.ai_1.output.text}}"
                    />
                </FormRow>
                <FormRow label="Written as" hint="Markdown is what AI steps produce; its headings, bold, links and tables are rendered properly.">
                    <select value={draft.contentFormat === 'html' ? 'html' : 'markdown'} onChange={(e) => set('contentFormat', e.target.value)} className={inputClass()}>
                        <option value="markdown">Markdown</option>
                        <option value="html">HTML</option>
                    </select>
                </FormRow>
            </AccordionSection>

            <AccordionSection stepType="generate_document" sectionKey="output" title="The file" defaultOpen forceOpen={errorSections.has('output')}>
                <FormRow label="Format" required>
                    <select value={format} onChange={(e) => set('format', e.target.value)} className={inputClass()}>
                        <option value="pdf">PDF</option>
                        <option value="docx">Word (.docx)</option>
                    </select>
                </FormRow>
                <FormRow label="Title" hint="Shown as the heading on the first page, and used as the filename when you leave that blank.">
                    <TemplateField
                        value={draft.title || ''}
                        onChange={(next) => set('title', next)}
                        rows={1}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder="Offerte {{trigger.output.bedrijf}}"
                    />
                </FormRow>
                <FormRow label="Filename" hint="Without the extension — that follows from the format.">
                    <TemplateField
                        value={draft.fileName || ''}
                        onChange={(next) => set('fileName', next)}
                        rows={1}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder="offerte-{{trigger.output.nummer}}"
                    />
                </FormRow>
            </AccordionSection>

            <AccordionSection stepType="generate_document" sectionKey="options" title="Options" forceOpen={errorSections.has('options')}>
                <FormRow label="Keep for" required hint="How long the download keeps working. The file is deleted afterwards — write it to Drive or Nextcloud as well if it has to be kept.">
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

/**
 * Fill a document — WHICH design, and a value per placeholder.
 *
 * The placeholder rows are not a fixed form: they are read from the document
 * the author picked (`placeholders`, computed server-side from the body
 * markup). That is the whole ergonomic point — an author binds the holes the
 * document actually has, named exactly as the document names them, instead of
 * copying strings between two tabs and discovering the typo on the printed
 * invoice.
 *
 * A LIST placeholder gets its own row with its per-item fields spelled out,
 * because binding it is the one thing with a rule: a single whole-array
 * reference, never mixed text. The hint says so where it is needed rather than
 * in documentation nobody opens.
 */
function FillDocumentFields({ draft, set, onFocusField, previewSample, errorSections = new Set() }) {
    const [templates, setTemplates] = useState(null);   // null = still loading
    const [loadError, setLoadError] = useState(null);
    const [query,setQuery] = useState('');
    const [contract,setContract] = useState(null);
    const [review,setReview] = useState(null);
    useEffect(()=>{
        if(!draft.documentId){setContract(null);return;}
        let alive=true;
        const version=draft.documentVersionId ? `?versionId=${encodeURIComponent(draft.documentVersionId)}` : '?versionId=baseline';
        documentRequest(`/${encodeURIComponent(draft.documentId)}/contract${version}`).then(r=>{if(alive)setContract(r.contract);}).catch(e=>{if(alive)setLoadError(e.message);});
        return()=>{alive=false;};
    },[draft.documentId,draft.documentVersionId]);
    const days = Number.isFinite(Number(draft.expiresInDays)) ? Number(draft.expiresInDays) : 7;

    useEffect(() => {
        let alive = true;
        listTemplates({query,limit:200})
            .then((list) => { if (alive) setTemplates(Array.isArray(list) ? list : []); })
            .catch((e) => { if (alive) { setTemplates([]); setLoadError(e?.message || 'Could not load your documents.'); } });
        return () => { alive = false; };
    }, [query]);

    const picked = useMemo(
        () => (templates || []).find(d => d.id === draft.documentId) || null,
        [templates, draft.documentId],
    );
    const placeholders = contract?.parameters || picked?.parameters || picked?.placeholders || [];

    const setValue = (key, next) => set('values', { ...(draft.values || {}), [key]: next });

    return (
        <>
            <AccordionSection stepType="fill_document" sectionKey="document" title="Document" defaultOpen forceOpen={errorSections.has('document')}>
                <input className={inputClass()} aria-label="Search document templates" placeholder="Search all templates…" value={query} onChange={e=>setQuery(e.target.value)}/>
                <FormRow label="Which document" required hint="One of the documents you designed in Studio → Documents. Design it there first if it is not in the list.">
                    <select
                        value={draft.documentId || ''}
                        onChange={(e) => {
                            const id = e.target.value;
                            const doc = (templates || []).find(d => d.id === id) || null;
                            set('documentId', id);
                            // The name rides along so the card and the header can
                            // say WHICH document without a fetch; the runner
                            // still resolves the id.
                            set('documentName', doc?.name || '');
                            set('documentVersionId', doc?.versionId);
                            set('sectionOverrides', {});
                        }}
                        className={inputClass()}
                        data-testid="fill-document-picker"
                    >
                        <option value="">{templates === null ? 'Loading your documents…' : 'Pick a document…'}</option>
                        {draft.documentId && !picked && <option value={draft.documentId}>{draft.documentName || contract?.name || draft.documentId}</option>}
                        {(templates || []).map(d => (
                            <option key={d.id} value={d.id}>{d.name}{d.placeholders?.length ? ` · ${d.placeholders.length} placeholder(s)` : ' · no placeholders'}</option>
                        ))}
                    </select>
                </FormRow>
                {loadError && <p className={`${hintTextClass()} text-[var(--error)]`}>{loadError}</p>}
                {templates !== null && templates.length === 0 && !loadError && (
                    <p className={AMBER_NOTE}>
                        You have no documents yet. Design the invoice, quote or letter in Studio → Documents —
                        write {'{{customer.name}}'} where a value should land — and it appears here.
                    </p>
                )}
                {picked && placeholders.length === 0 && (
                    <p className={hintTextClass()}>
                        This document has no placeholders, so it is sent exactly as designed. Add
                        {' '}{'{{'}name{'}}'} markers to it in Studio → Documents to fill it per run.
                    </p>
                )}
            </AccordionSection>

            {contract?.instructions && <p className={hintTextClass()}>{contract.instructions}</p>}
            {contract?.versionId && <p className={hintTextClass()}>Pinned revision: {contract.versionId.slice(0,8)}{picked?.versionId && contract.versionId !== picked.versionId && <button type="button" className="underline ml-2" onClick={async()=>{try{const r=await documentRequest(`/${draft.documentId}/contract`);setReview(r.contract);}catch(e){setLoadError(e.message);}}}>Review available update</button>}</p>}
            {review && <div className={cardClass()}><h4>Review template update</h4><p className={hintTextClass()}>{review.instructions}</p>{review.parameters.map(p=><p key={p.key} className={hintTextClass()}>{p.key}{p.required?' *':''} — {p.summary || p.instructions}</p>)}{review.sections.map(s=><p key={s.id} className={hintTextClass()}>{s.title}: {s.summary}</p>)}<button type="button" className="underline text-xs" onClick={()=>{set('documentVersionId',review.versionId);setReview(null);}}>Apply reviewed revision</button><button type="button" className="underline text-xs ml-3" onClick={()=>setReview(null)}>Cancel</button></div>}
            {contract?.sections?.map(s=><FormRow key={s.id} label={s.title} hint={s.summary}><select className={inputClass()} value={draft.sectionOverrides?.[s.id] || 'automatic'} onChange={e=>set('sectionOverrides',{...draft.sectionOverrides,[s.id]:e.target.value})}><option value="automatic">Automatic (rules)</option><option value="include">Include</option><option value="exclude">Exclude</option></select></FormRow>)}

            <AccordionSection stepType="fill_document" sectionKey="values" title="Values" defaultOpen forceOpen={errorSections.has('values')}>
                {!draft.documentId && <p className={hintTextClass()}>Pick a document first — its placeholders appear here.</p>}
                {placeholders.map((p) => (
                    <FormRow
                        key={p.key}
                        label={(p.label || p.key) + (p.required ? ' *' : '')}
                        hint={p.summary || p.instructions || (p.kind === 'list'
                            ? `A list${p.fields?.length ? `, one block per item with ${p.fields.join(', ')}` : ''}. Bind it to a whole list — one value and nothing else around it.`
                            : (p.kind === 'condition' ? 'Decides whether its block is printed at all.' : undefined))}
                    >
                        <TemplateField
                            value={String((draft.values || {})[p.key] ?? '')}
                            onChange={(next) => setValue(p.key, p.type === 'number' && next.trim() && Number.isFinite(Number(next)) ? Number(next) : p.type === 'boolean' && ['true','false'].includes(next) ? next === 'true' : next)}
                            rows={1}
                            onFocusField={onFocusField}
                            previewSample={previewSample}
                            placeholder={p.kind === 'list' ? '{{steps.rows.output.rows}}' : '{{steps.extract.output.naam}}'}
                        />
                        {p.instructions && <details className={hintTextClass()}><summary>Instructions</summary><p>{p.instructions}</p>{p.example !== undefined && <p>Example: {typeof p.example==='object'?JSON.stringify(p.example):String(p.example)}</p>}</details>}
                    </FormRow>
                ))}
            </AccordionSection>

            <AccordionSection stepType="fill_document" sectionKey="output" title="The file" forceOpen={errorSections.has('output')}>
                {(picked?.docType === 'presentation' || contract?.docType === 'presentation') && (
                    <FormRow label="Format" hint="A presentation is filled into a real PowerPoint file, or into a PDF deck.">
                        <select value={draft.format === 'pdf' ? 'pdf' : 'pptx'} onChange={(e) => set('format', e.target.value)} className={inputClass()} data-testid="fill-document-format">
                            <option value="pptx">PowerPoint (.pptx)</option>
                            <option value="pdf">PDF deck</option>
                        </select>
                    </FormRow>
                )}
                <FormRow label="Filename" hint={(picked?.docType === 'presentation' || contract?.docType === 'presentation') ? "Without the extension — that is added. Leave it blank to use the presentation's own name." : "Without the .pdf — that is added. Leave it blank to use the document's own name."}>
                    <TemplateField
                        value={draft.fileName || ''}
                        onChange={(next) => set('fileName', next)}
                        rows={1}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder="factuur-{{steps.extract.output.nummer}}"
                    />
                </FormRow>
                <FormRow label="Also keep it in Documents" hint="Keeps the FILLED document in Studio → Documents so you can correct a line by hand before it goes out. Leave it off for a routine that runs often — it makes a document every run.">
                    <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                        <input type="checkbox" checked={draft.saveCopy === true} onChange={(e) => set('saveCopy', e.target.checked)} />
                        Keep a copy
                    </label>
                </FormRow>
                {draft.saveCopy === true && (
                    <FormRow label="Name of the copy" hint="Defaults to the document's name plus today's date.">
                        <TemplateField
                            value={draft.copyName || ''}
                            onChange={(next) => set('copyName', next)}
                            rows={1}
                            onFocusField={onFocusField}
                            previewSample={previewSample}
                            placeholder="Factuur {{steps.extract.output.nummer}}"
                        />
                    </FormRow>
                )}
            </AccordionSection>

            <AccordionSection stepType="fill_document" sectionKey="options" title="Options" forceOpen={errorSections.has('options')}>
                <FormRow label="Keep for" required hint="How long the download keeps working. The file is deleted afterwards — write it to Drive or Nextcloud as well if it has to be kept.">
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

export { GenerateDocumentFields, FillDocumentFields };
