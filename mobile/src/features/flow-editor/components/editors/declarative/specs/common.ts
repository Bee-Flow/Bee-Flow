/**
 * What several step editors share on the web, once: the section names, the
 * "Run once per item" / "Try again" rows (collectionEditors.jsx ForEachSection
 * and RetrySection), a collection's source list and input cap
 * (CollectionArrayRefField), and a file's "Keep for".
 */

import { elementFieldOptions, resolveElementSample } from '@/features/flow-editor/bindings';
import type { FormDraft } from '@/features/flow-editor/formState';

import { msg, type FieldSpec, type SpecContext, type When } from '../spec';

export const TITLES = {
    configuration: msg('mobile.flow.section.configuration', 'Configuration'),
    advanced: msg('mobile.flow.section.advanced', 'Advanced'),
    options: msg('mobile.flow.section.options', 'Options'),
    file: msg('mobile.flow.section.the_file', 'The file'),
    content: msg('mobile.flow.section.content', 'Content'),
    inputs: msg('automations.ai_step_editors.inputs', 'Inputs'),
    returns: msg('mobile.flow.section.returns', 'Returns'),
} as const;

/** `retry` is configured: `max: 0` is the runner's own "do not retry". */
export function retryIsSet(draft: FormDraft): boolean {
    const retry = draft.retry as { max?: unknown } | null | undefined;
    return !!retry && Number(retry.max) > 0;
}

/** The Advanced band of a step that can repeat and retry: open, and kept in Simple, once either is on. */
export const repeatsOrRetries: When = (draft) => !!draft.forEach || retryIsSet(draft);

export const FOR_EACH: FieldSpec = { kind: 'forEach', key: 'forEach' };

/** Rendered only where the step's draft carries `retry` (formState RETRY_FORM_TYPES). */
export const RETRY: FieldSpec = { kind: 'retry', key: 'retry', visibleWhen: (draft) => 'retry' in draft };

export const ASK_ONCE: FieldSpec = { kind: 'askOnce', key: 'askOnce' };

export const SOURCE_LIST: FieldSpec = {
    kind: 'path',
    key: 'arrayRef',
    list: true,
    required: true,
    label: msg('automations.collection_editors.source_list', 'Source list'),
    hint: msg('automations.collection_editors.pick_a_list_from_a_previous', 'Pick a list from a previous step — or type a path manually.'),
    prompt: msg('automations.collection_editors.no_list_picked_yet', 'No list picked yet'),
};

/** The optional input cap (C19): blank is the platform default. */
export const MAX_ITEMS: FieldSpec = {
    kind: 'number',
    key: 'maxItems',
    min: 1,
    max: 10000,
    integer: true,
    allowBlank: true,
    example: '10000',
    label: msg('automations.collection_editors.max_input_items', 'Max input items'),
    hint: msg(
        'automations.collection_editors.optional_cap_on_input_size_the',
        'Optional cap on input size — the run FAILS if the source list is larger (platform cap 10 000). Leave blank for the default.',
    ),
};

/** The keys of the source list's items, as suggestions for a key field. */
export function itemKeys(draft: FormDraft, ctx: SpecContext): string[] {
    return elementFieldOptions(resolveElementSample(draft.arrayRef, ctx.sampleRoot)).map((o) => o.key);
}

const keepFor = (hint: FieldSpec['hint']): FieldSpec => ({
    kind: 'number',
    key: 'expiresInDays',
    min: 1,
    max: 90,
    integer: true,
    required: true,
    label: msg('mobile.flow.doc.keep_for', 'Keep for'),
    suffix: msg('mobile.flow.doc.days', 'days'),
    hint,
});

/** How long a made file's download works (1–90 days, the validator's clamp). */
export const KEEP_FOR = keepFor(
    msg(
        'mobile.flow.doc.keep_for_hint',
        'How long the download keeps working. The file is deleted afterwards — write it to Drive or Nextcloud as well if it has to be kept.',
    ),
);

/** The deck's wording of the same field. */
export const KEEP_DECK_FOR = keepFor(
    msg(
        'mobile.flow.doc.keep_deck_for_hint',
        'How long the download keeps working. The file is deleted afterwards — save it to Nextcloud as well if it has to be kept.',
    ),
);
