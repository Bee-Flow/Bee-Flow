/**
 * A note on the canvas — the web edits it in place (flow/nodes/NoteNode.jsx):
 * its text and one of eight colours, amber the default and stored as absence.
 * formState has no family for a note, so the spec carries its own draft and
 * patch for those two keys.
 */

import type { FlowNode } from '@/features/flow-editor/bindings';
import type { FormDraft, StepPatch } from '@/features/flow-editor/formState';

import { msg, type EditorSpec } from '../spec';

/** The web's COLOR_KEYS, amber first (the default). */
export const NOTE_COLORS = ['amber', 'blue', 'green', 'orange', 'rose', 'red', 'cyan', 'slate'] as const;

const COLOR_WORDS: Record<(typeof NOTE_COLORS)[number], string> = {
    amber: 'Amber',
    blue: 'Blue',
    green: 'Green',
    orange: 'Orange',
    rose: 'Rose',
    red: 'Red',
    cyan: 'Cyan',
    slate: 'Slate',
};

function extractNote(step: FlowNode): FormDraft {
    const color = typeof step.color === 'string' && (NOTE_COLORS as readonly string[]).includes(step.color) ? step.color : 'amber';
    return { text: typeof step.text === 'string' ? step.text : '', color };
}

function patchNote(patch: StepPatch, _step: FlowNode, draft: FormDraft): void {
    patch.text = typeof draft.text === 'string' ? draft.text : '';
    patch.color = draft.color && draft.color !== 'amber' ? draft.color : undefined;
}

export const NOTE: EditorSpec = {
    type: 'note',
    extract: extractNote,
    patch: patchNote,
    sections: [
        {
            key: 'content',
            title: msg('mobile.flow.note.section', 'Note'),
            defaultOpen: true,
            fields: [
                { kind: 'multiline', key: 'text', label: msg('mobile.flow.note.text', 'Text'), prompt: msg('mobile.flow.note.prompt', 'Write a note…') },
                {
                    kind: 'select',
                    key: 'color',
                    label: msg('mobile.flow.note.color', 'Colour'),
                    options: NOTE_COLORS.map((c) => ({ value: c, label: msg(`mobile.flow.note.color_${c}`, COLOR_WORDS[c]) })),
                },
            ],
        },
    ],
};
