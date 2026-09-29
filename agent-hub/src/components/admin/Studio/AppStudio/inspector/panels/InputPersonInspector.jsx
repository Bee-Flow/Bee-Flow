import React from 'react';
import { TextField, usePatch } from './kit';
import { registerInspector } from '../registry';
import Toggle from '../../../../../shared/Toggle';

/**
 * Content panel for input_person. Props mirror componentSpecs.js (authoritative).
 *
 * There is no source to choose: the list is always the organisation's own
 * members, answered by the platform. What the author picks is what the field
 * is called and whether "Me" is offered — so the panel is short on purpose.
 *
 * The note about the directory switch is here rather than buried in docs
 * because an app that has not opted in renders a picker that loads nothing, and
 * "the dropdown is empty" is a much worse thing to debug than "you have not
 * turned this on yet".
 */
export default function InputPersonInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <TextField
                label="Field name"
                value={props.name}
                onChange={(v) => patch({ name: v })}
                hint={`Submits the user id. Also publishes ${props.name || 'person'}_label with the display name — write both, so the row can show who it belongs to.`}
                disabled={disabled}
            />
            <TextField label="Label" value={props.label} onChange={(v) => patch({ label: v })} disabled={disabled} />
            <Toggle
                label="Offer “Me”"
                checked={props.allowMe !== false}
                onChange={(v) => patch({ allowMe: v })}
                disabled={disabled}
                size="sm"
            />
            <Toggle
                label="Allow several people"
                checked={!!props.multiple}
                onChange={(v) => patch({ multiple: v })}
                disabled={disabled}
                size="sm"
            />
            <Toggle
                label="Required"
                checked={!!props.required}
                onChange={(v) => patch({ required: v })}
                disabled={disabled}
                size="sm"
            />
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                The list is your organisation’s members. It stays empty until this app is
                allowed to read the directory — turn that on in the app’s Data settings.
            </p>
        </div>
    );
}

registerInspector('input_person', InputPersonInspector);
