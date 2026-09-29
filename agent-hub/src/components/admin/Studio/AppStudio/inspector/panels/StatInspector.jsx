import React from 'react';
import { registerInspector } from '../registry';
import BindingField from './BindingField';
import { TextField, IconField, SelectField, usePatch } from './kit';

// Mirror of the stat `look` enum (componentSpecs.js, authoritative — first
// value is the default and renders exactly what stat always rendered).
const LOOKS = [
    { value: 'plain', label: 'Plain' },
    { value: 'tile', label: 'Tile' },
    { value: 'tinted', label: 'Tinted' },
    { value: 'accent', label: 'Accent' },
    { value: 'gradient', label: 'Gradient' },
];

export default function StatInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <TextField label="Label" value={props.label} onChange={(v) => patch({ label: v })} disabled={disabled} />
            <BindingField
                label="Data"
                value={props.value}
                onChange={(v) => patch({ value: v })}
                definition={definition}
                componentType="stat"
                singleValue
                hint="Where the number on this tile comes from."
                placeholder="0"
                disabled={disabled}
            />
            <TextField
                label="Caption"
                value={props.caption}
                onChange={(v) => patch({ caption: v || null })}
                placeholder="Optional caption"
                disabled={disabled}
            />
            <IconField label="Icon" value={props.icon} onChange={(v) => patch({ icon: v })} disabled={disabled} />
            <SelectField
                label="Look"
                value={props.look ?? 'plain'}
                onChange={(v) => patch({ look: v })}
                options={LOOKS}
                disabled={disabled}
            />
        </div>
    );
}

registerInspector('stat', StatInspector);
