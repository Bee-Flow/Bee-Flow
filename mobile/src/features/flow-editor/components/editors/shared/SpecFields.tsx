/**
 * Plain fields described as declarative specs, inside a bespoke step editor:
 * rendered and saved exactly as the declarative editor renders and saves them
 * (a change is one `setMany`).
 */

import React from 'react';

import { FieldRenderer } from '../declarative/FieldRenderer';
import { fieldId } from '../declarative/runtime';
import type { FieldSpec, SpecContext } from '../declarative/spec';
import type { StepEditorProps } from '../types';

export function specContext(props: StepEditorProps): SpecContext {
    return { ...props.ctx, step: props.step };
}

/** Spec fields over the editor's draft; a change is one `setMany`, as in the declarative editor. */
export function SpecFields({ editor, fields }: { editor: StepEditorProps; fields: readonly FieldSpec[] }) {
    const ctx = specContext(editor);
    return (
        <>
            {fields.map((f) => (
                <FieldRenderer key={fieldId(f)} field={f} draft={editor.draft} ctx={ctx} onDraft={editor.setMany} />
            ))}
        </>
    );
}
