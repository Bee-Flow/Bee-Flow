import React from 'react';
import FormField from '../../../../../shared/FormField';
import Toggle from '../../../../../shared/Toggle';
import ExpressionInput from '../logic/ExpressionInput';
import { registerInspector } from '../registry';
import { TextField , usePatch } from './kit';

export default function FormInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <TextField
                label="Submit label"
                value={props.submitLabel}
                onChange={(v) => patch({ submitLabel: v })}
                placeholder="Submit"
                disabled={disabled}
            />
            <Toggle
                label="Show reset"
                description="Adds a button that clears the form."
                checked={!!props.showReset}
                onChange={(v) => patch({ showReset: v })}
                disabled={disabled}
                size="sm"
            />
            <TextField
                label="Form name"
                value={props.name}
                onChange={(v) => patch({ name: v || null })}
                hint="Used to reference this form from actions."
                disabled={disabled}
            />
            <FormField label="Start over when this changes" hint="A formula — usually the selected record's id. Fields return to their defaults and re-read their values, so a form that edits one record never keeps the previous record's values.">
                <ExpressionInput
                    variant="inline"
                    value={props.resetKey || ''}
                    onChange={(v) => patch({ resetKey: v || null })}
                    definition={definition}
                    node={node}
                    ariaLabel="Start over when this changes"
                    placeholder="e.g. vars.selected.id"
                    disabled={disabled}
                />
            </FormField>
        </div>
    );
}

registerInspector('form', FormInspector);
