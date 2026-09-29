import React from 'react';
import FormField from '../../../../../shared/FormField';
import SegmentedControl from '../../../../../shared/SegmentedControl';
import { registerInspector } from '../registry';
import { TextField, SelectField, usePatch } from './kit';

const LEVELS = [
    { value: 1, label: 'H1' },
    { value: 2, label: 'H2' },
    { value: 3, label: 'H3' },
];

// Mirror of the heading `accent` enum (componentSpecs.js, authoritative —
// first value is the default and renders exactly what heading always
// rendered). `level` says how big, `accent` says how loud.
const ACCENTS = [
    { value: 'none', label: 'None' },
    { value: 'bar', label: 'Bar' },
    { value: 'tinted', label: 'Tinted' },
];

export default function HeadingInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <TextField label="Text" value={props.text} onChange={(v) => patch({ text: v })} disabled={disabled} />
            <FormField label="Level">
                <SegmentedControl
                    value={props.level ?? 2}
                    onChange={(v) => patch({ level: v })}
                    options={LEVELS}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel="Heading level"
                />
            </FormField>
            <SelectField
                label="Accent"
                value={props.accent ?? 'none'}
                onChange={(v) => patch({ accent: v })}
                options={ACCENTS}
                disabled={disabled}
            />
        </div>
    );
}

registerInspector('heading', HeadingInspector);
