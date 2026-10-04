// The knowledge-write node's settings panel.
//
// Three things this panel has to get across, and none of them are obvious from
// the fields alone:
//
//   1. WHERE it lands, and that not every base is a choice. A base you can read
//      is not a base you may add to, so one you cannot write to is shown
//      disabled with the reason rather than quietly missing — the same posture
//      the datatable picker takes.
//   2. That the text becomes an ANSWER. What lands here is what an agent will
//      later state as fact, with a citation. That is a different bar from a
//      row in a table.
//   3. That without a source reference, every run leaves ANOTHER document.
//      This is the one mistake that costs the most and shows up the latest: the
//      automation works, nothing errors, and six months later nobody can explain
//      why the base has two thousand near-identical entries.
import { BookOpen } from 'lucide-react';
import { useMemo } from 'react';
import TemplateField from '../../mapping/TemplateField';
import AccordionSection from '../AccordionSection';
import { ForEachSection, RetrySection, retryIsSet } from './collectionEditors';
import { FormRow, inputClass } from './formPrimitives';
import useForEachRequest from '../../mapping/useForEachRequest';

/** Fallback list, so the panel still works if the catalog call failed. */
const FALLBACK_STRATEGIES = [
    { value: 'skip', label: 'Keep what is there', blurb: 'If the base already holds nearly the same text, leave it alone.' },
    { value: 'merge', label: 'Merge into one', blurb: 'Combine the two into a single, richer document.' },
    { value: 'replace', label: 'Replace it', blurb: 'Overwrite the near-identical document with this one.' },
    { value: 'add', label: 'Add it anyway', blurb: 'Store it as its own document, even if a similar one exists.' },
];

function DestinationSection({ draft, set, onFocusField, errorSections, bases }) {
    const base = useMemo(() => bases.find(b => b.id === draft.knowledgeBaseId) || null, [bases, draft.knowledgeBaseId]);

    return (
        <AccordionSection
            stepType="knowledge_write" sectionKey="destination" title="Where it goes" defaultOpen
            forceOpen={errorSections.has('destination')}
        >
            <FormRow
                label="Knowledge base"
                required
                hint="Your agents answer from what is in here. Only a base you manage can be written to — being able to read one is not permission to add to it."
            >
                {bases.length === 0 ? (
                    // Never a bare empty dropdown: an empty state that does not
                    // say why reads as broken.
                    <div className="text-xs text-slate-500 dark:text-slate-400 flex items-start gap-2 py-1">
                        <BookOpen size={14} className="mt-0.5 shrink-0" />
                        <span>
                            No knowledge bases yet. Create one in
                            <strong> Studio &rarr; Knowledge</strong>; once you manage one it appears here.
                        </span>
                    </div>
                ) : (
                    <select
                        className={inputClass()}
                        value={draft.knowledgeBaseId || ''}
                        onChange={(e) => set('knowledgeBaseId', e.target.value)}
                        onFocus={() => onFocusField?.('knowledgeBaseId')}
                    >
                        <option value="">Pick a knowledge base…</option>
                        {bases.map(b => (
                            <option key={b.id} value={b.id} disabled={!b.canWrite}>
                                {b.name}
                                {b.scope === 'org' ? ' · shared' : ''}
                                {b.canWrite ? '' : ' — you can only read this one'}
                            </option>
                        ))}
                    </select>
                )}
            </FormRow>

            {base && base.scope === 'org' && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400 px-1">
                    This base is shared — what this step writes becomes an answer your colleagues&rsquo; agents give.
                </p>
            )}
        </AccordionSection>
    );
}

function ContentSection({ draft, set, onFocusField, previewSample, errorSections }) {
    // A separate run per item (under a field's More) sets this step's forEach.
    const forEach = useForEachRequest(draft, set);
    const repeats = !String(draft.sourceUri || '').trim();

    return (
        <AccordionSection
            stepType="knowledge_write" sectionKey="content" title="What to save" defaultOpen
            forceOpen={errorSections.has('content')}
        >
            <FormRow
                label="Text"
                required
                hint="Click a value in the right panel to insert it — usually the step that wrote the article. An agent will quote this back as fact, so send it finished text, not working notes."
            >
                <TemplateField
                    onRequestForEach={forEach.request}
                    canForEach={forEach.allowed}
                    value={draft.content || ''}
                    onChange={(next) => set('content', next)}
                    rows={4}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                    placeholder="{{steps.ai_1.output.text}}"
                />
            </FormRow>

            <FormRow label="Title" hint="What the document is called where a person browses the base.">
                <TemplateField
                    onRequestForEach={forEach.request}
                    canForEach={forEach.allowed}
                    value={draft.title || ''}
                    onChange={(next) => set('title', next)}
                    rows={1}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                    placeholder="{{steps.ai_1.output.title}}"
                />
            </FormRow>

            <FormRow
                label="Source reference"
                hint="Something stable and unique for this subject — a ticket link, a record id. The next run with the same reference REPLACES this document instead of adding another."
            >
                <TemplateField
                    onRequestForEach={forEach.request}
                    canForEach={forEach.allowed}
                    value={draft.sourceUri || ''}
                    onChange={(next) => set('sourceUri', next)}
                    rows={1}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                    placeholder="ticket:{{trigger.output.id}}"
                />
            </FormRow>

            {repeats && (
                // Deliberately not phrased as an error — writing a genuinely new
                // document every run is a real, if rare, intent. It is phrased as
                // the consequence, because that is the part people do not picture.
                <p className="text-[11px] text-amber-700 dark:text-amber-400 px-1">
                    Without a source reference this adds a NEW document every time it runs.
                </p>
            )}
        </AccordionSection>
    );
}

function AdvancedSection({ draft, set, groups, onFocusField, errorSections, strategies }) {
    const strategy = draft.nearDuplicateStrategy || 'skip';

    return (
        <AccordionSection
            stepType="knowledge_write" sectionKey="advanced" title="Advanced"
            forceOpen={errorSections.has('advanced')}
            hasContent={!!draft.forEach || retryIsSet(draft) || strategy !== 'skip'}
        >
            <FormRow
                label="If something similar is already there"
                hint="Only about text on a DIFFERENT subject that reads nearly the same. The same source reference always replaces its own document, whichever of these you pick."
            >
                <select
                    className={inputClass()}
                    value={strategy}
                    onChange={(e) => set('nearDuplicateStrategy', e.target.value)}
                    onFocus={() => onFocusField?.('nearDuplicateStrategy')}
                >
                    {strategies.map(s => (
                        <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                </select>
            </FormRow>
            <p className="text-[11px] text-[var(--text-tertiary)] px-1">
                {strategies.find(s => s.value === strategy)?.blurb || ''}
            </p>

            <FormRow label="Iteration" hint="Off by default: the step runs once. Turn on to write one document per item of an upstream list (then reference {{loop.item…}} in the text, the title and the source reference).">
                <ForEachSection draft={draft} set={set} groups={groups} onFocusField={onFocusField} />
            </FormRow>
            <RetrySection draft={draft} set={set} />
        </AccordionSection>
    );
}

export default function KnowledgeWriteFields({
    draft, set, groups, onFocusField, previewSample,
    errorSections = new Set(), catalog = null,
}) {
    const bases = useMemo(() => (catalog?.knowledgeBases || []), [catalog]);
    const strategies = useMemo(
        () => (catalog?.knowledgeWriteStrategies?.length ? catalog.knowledgeWriteStrategies : FALLBACK_STRATEGIES),
        [catalog],
    );

    return (
        <>
            <DestinationSection
                draft={draft} set={set} onFocusField={onFocusField}
                errorSections={errorSections} bases={bases}
            />
            <ContentSection
                draft={draft} set={set} onFocusField={onFocusField}
                previewSample={previewSample} errorSections={errorSections}
            />
            <AdvancedSection
                draft={draft} set={set} groups={groups} onFocusField={onFocusField}
                errorSections={errorSections} strategies={strategies}
            />
        </>
    );
}
