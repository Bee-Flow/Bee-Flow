import { buildPatch, extractFormState } from '@/features/flow-editor/formState';

import { DeclarativeEditor, JsonStepEditor, SPECS } from './declarative';
import { EDITORS, editorFor, editorKindFor, stepFormFor } from './registry';

describe('the editor registry', () => {
    it('gives a spec’d type the declarative editor, and anything else the JSON view', () => {
        for (const type of Object.keys(SPECS)) {
            expect(editorKindFor(type)).toBe(EDITORS[type] ? 'bespoke' : 'declarative');
            if (!EDITORS[type]) expect(editorFor(type)).toBe(DeclarativeEditor);
        }
        expect(editorFor('mystery')).toBe(JsonStepEditor);
        expect(editorKindFor(undefined)).toBe('json');
        expect(editorKindFor('constructor')).toBe('json');
    });

    it('extracts and patches with formState unless the spec carries its own keys', () => {
        expect(stepFormFor('wait')).toEqual({ extract: extractFormState, patch: buildPatch });
        const note = stepFormFor('note');
        expect(note.extract({ id: 'n', type: 'note', text: 'hi' })).toMatchObject({ text: 'hi', color: 'amber' });
        expect(note.patch({ id: 'n', type: 'note', text: 'hi', label: '', icon: '' }, { label: '', icon: '', text: 'bye', color: 'amber' })).toEqual({
            label: null,
            icon: null,
            text: 'bye',
        });
    });
});
