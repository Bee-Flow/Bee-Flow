import React from 'react';
import { registerInspector } from '../registry';
import { TextField, TextAreaField, SelectField, usePatch } from './kit';

// Mirror of the card `look` enum (componentSpecs.js, authoritative — first
// value is the default and renders exactly what card always rendered).
const LOOKS = [
    { value: 'default', label: 'Default' },
    { value: 'flat', label: 'Flat' },
    { value: 'raised', label: 'Raised' },
    { value: 'tinted', label: 'Tinted' },
    { value: 'accent', label: 'Accent' },
    { value: 'gradient', label: 'Gradient' },
    { value: 'solid', label: 'Solid' },
];

export default function CardInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <TextField
                label="Title"
                value={props.title}
                onChange={(v) => patch({ title: v || null })}
                placeholder="Optional title"
                disabled={disabled}
            />
            <TextAreaField
                label="Description"
                value={props.description}
                onChange={(v) => patch({ description: v || null })}
                placeholder="Optional description"
                rows={2}
                disabled={disabled}
            />
            <SelectField
                label="Look"
                value={props.look ?? 'default'}
                onChange={(v) => patch({ look: v })}
                options={LOOKS}
                disabled={disabled}
            />
        </div>
    );
}

registerInspector('card', CardInspector);
