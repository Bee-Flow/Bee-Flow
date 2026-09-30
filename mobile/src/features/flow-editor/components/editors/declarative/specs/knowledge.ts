/**
 * Save to a knowledge base — the web's KnowledgeWriteFields
 * (settings/knowledgeWriteEditors.jsx). The bases come from the catalog; one
 * the author can only read is offered, disabled, with the reason — never
 * silently left out. The duplicate strategies come from the catalog too, with
 * the web's own list as the fallback when the catalog could not be read.
 */

import type { FormDraft } from '@/features/flow-editor/formState';

import { msg, type EditorSpec, type OptionSpec, type SpecContext } from '../spec';
import { FOR_EACH, retryIsSet, RETRY, TITLES } from './common';

/** The web's FALLBACK_STRATEGIES, for a catalog that did not answer. */
export const FALLBACK_STRATEGIES: readonly OptionSpec[] = [
    {
        value: 'skip',
        label: msg('mobile.flow.kb.skip', 'Keep what is there'),
        blurb: msg('mobile.flow.kb.skip_blurb', 'If the base already holds nearly the same text, leave it alone.'),
    },
    {
        value: 'merge',
        label: msg('mobile.flow.kb.merge', 'Merge into one'),
        blurb: msg('mobile.flow.kb.merge_blurb', 'Combine the two into a single, richer document.'),
    },
    {
        value: 'replace',
        label: msg('mobile.flow.kb.replace', 'Replace it'),
        blurb: msg('mobile.flow.kb.replace_blurb', 'Overwrite the near-identical document with this one.'),
    },
    {
        value: 'add',
        label: msg('mobile.flow.kb.add', 'Add it anyway'),
        blurb: msg('mobile.flow.kb.add_blurb', 'Store it as its own document, even if a similar one exists.'),
    },
];

function baseOptions(_draft: FormDraft, ctx: SpecContext): OptionSpec[] {
    return (ctx.catalog?.knowledgeBases ?? []).map((b) => ({
        value: b.id,
        label: b.scope === 'org' ? msg('mobile.flow.kb.shared_base', '{name} · shared', { name: b.name }) : b.name,
        blurb: b.canWrite ? undefined : msg('mobile.flow.kb.read_only', 'You can only read this one'),
        disabled: !b.canWrite,
    }));
}

function strategyOptions(_draft: FormDraft, ctx: SpecContext): readonly OptionSpec[] {
    const fromCatalog = ctx.catalog?.knowledgeWriteStrategies ?? [];
    if (!fromCatalog.length) return FALLBACK_STRATEGIES;
    return fromCatalog.map((s) => ({ value: s.value, label: s.label, blurb: s.blurb }));
}

const noBases = (_draft: FormDraft, ctx: SpecContext) => !(ctx.catalog?.knowledgeBases ?? []).length;
const sharedBase = (draft: FormDraft, ctx: SpecContext) =>
    (ctx.catalog?.knowledgeBases ?? []).some((b) => b.id === draft.knowledgeBaseId && b.scope === 'org');

export const KNOWLEDGE_WRITE: EditorSpec = {
    type: 'knowledge_write',
    sections: [
        {
            key: 'destination',
            title: msg('mobile.flow.kb.destination', 'Where it goes'),
            defaultOpen: true,
            fields: [
                {
                    kind: 'select',
                    key: 'knowledgeBaseId',
                    required: true,
                    visibleWhen: (draft, ctx) => !noBases(draft, ctx),
                    label: msg('mobile.flow.kb.base', 'Knowledge base'),
                    hint: msg(
                        'mobile.flow.kb.base_hint',
                        'Your agents answer from what is in here. Only a base you manage can be written to — being able to read one is not permission to add to it.',
                    ),
                    prompt: msg('mobile.flow.kb.pick', 'Pick a knowledge base…'),
                    options: baseOptions,
                },
                {
                    kind: 'note',
                    id: 'noBases',
                    visibleWhen: noBases,
                    hint: msg(
                        'mobile.flow.kb.none',
                        'No knowledge bases yet. Create one in Studio → Knowledge; once you manage one it appears here.',
                    ),
                },
                {
                    kind: 'note',
                    id: 'shared',
                    tone: 'warning',
                    visibleWhen: sharedBase,
                    hint: msg('mobile.flow.kb.shared_note', 'This base is shared — what this step writes becomes an answer your colleagues’ agents give.'),
                },
            ],
        },
        {
            key: 'content',
            title: msg('mobile.flow.kb.content', 'What to save'),
            defaultOpen: true,
            fields: [
                {
                    kind: 'template',
                    key: 'content',
                    multiline: true,
                    required: true,
                    example: '{{steps.ai_1.output.text}}',
                    label: msg('mobile.flow.kb.text', 'Text'),
                    hint: msg(
                        'mobile.flow.kb.text_hint',
                        'Usually the step that wrote the article. An agent will quote this back as fact, so send it finished text, not working notes.',
                    ),
                },
                {
                    kind: 'template',
                    key: 'title',
                    example: '{{steps.ai_1.output.title}}',
                    label: msg('mobile.flow.kb.title', 'Title'),
                    hint: msg('mobile.flow.kb.title_hint', 'What the document is called where a person browses the base.'),
                },
                {
                    kind: 'template',
                    key: 'sourceUri',
                    example: 'ticket:{{trigger.output.id}}',
                    label: msg('mobile.flow.kb.source', 'Source reference'),
                    hint: msg(
                        'mobile.flow.kb.source_hint',
                        'Something stable and unique for this subject — a ticket link, a record id. The next run with the same reference REPLACES this document instead of adding another.',
                    ),
                },
                {
                    kind: 'note',
                    id: 'repeats',
                    tone: 'warning',
                    visibleWhen: (draft) => !String(draft.sourceUri || '').trim(),
                    hint: msg('mobile.flow.kb.repeats', 'Without a source reference this adds a NEW document every time it runs.'),
                },
            ],
        },
        {
            key: 'advanced',
            title: TITLES.advanced,
            hasContent: (draft) => !!draft.forEach || retryIsSet(draft) || (draft.nearDuplicateStrategy || 'skip') !== 'skip',
            fields: [
                {
                    kind: 'select',
                    key: 'nearDuplicateStrategy',
                    read: (draft) => draft.nearDuplicateStrategy || 'skip',
                    label: msg('mobile.flow.kb.similar', 'If something similar is already there'),
                    hint: msg(
                        'mobile.flow.kb.similar_hint',
                        'Only about text on a DIFFERENT subject that reads nearly the same. The same source reference always replaces its own document, whichever of these you pick.',
                    ),
                    options: strategyOptions,
                },
                {
                    ...FOR_EACH,
                    hint: msg(
                        'mobile.flow.kb.iteration_hint',
                        'Off by default: the step runs once. Turn on to write one document per item of an upstream list (then pick the item’s fields with Insert data, under Current item, in the text, the title and the source reference).',
                    ),
                },
                RETRY,
            ],
        },
    ],
};
