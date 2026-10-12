/**
 * The three trigger kinds that DECLARE what they are called with instead of
 * firing on their own (triggerEditors.jsx) — LayerInputFields, AgentCallFields
 * and AppTriggerFields — bind every parameter as `trigger.output.<name>`, so
 * a rename is carried through the whole automation (ctx.renameField).
 */

import type { StepEditorProps } from '../types';

const BASE = 'trigger.output';

export function carryOf(editor: StepEditorProps) {
    const rename = editor.ctx.renameField;
    return rename ? (from: string, to: string) => rename(BASE, from, to) : null;
}
