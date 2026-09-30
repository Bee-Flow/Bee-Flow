/**
 * Extract data — the web's DataExtractionFields
 * (actionEditors/dataExtractionFields.jsx), whose words are the web's own
 * `routines.ndv.extraction.*` keys: the text to read (a binding), the field
 * rows (name, type, required, what to look for), and optional instructions.
 */

import { MAX_EXTRACTION_INSTRUCTIONS } from '@/features/flow-editor/formState';

import { msg, type EditorSpec } from '../spec';
import { FOR_EACH, repeatsOrRetries, RETRY, TITLES } from './common';

const X = 'routines.ndv.extraction';

export const DATA_EXTRACTION: EditorSpec = {
    type: 'data_extraction',
    sections: [
        {
            key: 'source',
            title: msg(`${X}.source`, 'Text to read'),
            intro: msg(
                'mobile.flow.extraction.source_intro',
                'The text the fields are read from — usually the output of the step that fetched the document or e-mail.',
            ),
            defaultOpen: true,
            fields: [
                { kind: 'binding', key: 'source', required: true, prompt: msg('mobile.flow.extraction.pick', 'Pick a value from an earlier step') },
                { kind: 'note', id: 'model', hint: msg(`${X}.model_note`, 'Runs on the extraction model set by your administrator') },
            ],
        },
        {
            key: 'fields',
            title: msg(`${X}.fields`, 'Fields to extract'),
            intro: msg(
                'mobile.flow.extraction.fields_intro',
                'One row per value to pull out. The name becomes the output key the next steps bind to; the description tells the model what to look for. A field it cannot find comes back empty.',
            ),
            defaultOpen: true,
            fields: [{ kind: 'extraction', key: 'fields' }],
        },
        {
            key: 'instructions',
            title: msg(`${X}.instructions`, 'Extra instructions'),
            intro: msg(
                'mobile.flow.extraction.instructions_intro',
                'Optional. Anything the model should know that the field descriptions do not say — the currency, the language, which of two dates counts.',
            ),
            defaultOpen: (draft) => !!draft.instructions,
            hasContent: (draft) => !!draft.instructions,
            fields: [
                {
                    kind: 'multiline',
                    key: 'instructions',
                    maxLength: MAX_EXTRACTION_INSTRUCTIONS,
                    example: 'Amounts are in euros. Dates are written day first.',
                    label: msg(`${X}.instructions`, 'Extra instructions'),
                },
            ],
        },
        {
            key: 'advanced',
            title: TITLES.advanced,
            defaultOpen: repeatsOrRetries,
            hasContent: repeatsOrRetries,
            fields: [FOR_EACH, RETRY],
        },
    ],
};
