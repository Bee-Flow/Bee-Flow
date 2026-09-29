import React from 'react';
import { registerInspector } from '../registry';
import { SelectField, usePatch } from './kit';

// Mirror of the container `look` enum (componentSpecs.js, authoritative —
// first value is the default: the invisible, layout-only container it has
// always been).
const LOOKS = [
    { value: 'plain', label: 'Plain' },
    { value: 'panel', label: 'Panel' },
    { value: 'tinted', label: 'Tinted' },
    { value: 'outlined', label: 'Outlined' },
];

/**
 * Content panel for `container`. Bespoke rather than SpecPanel on purpose:
 * container was prop-less until the look pass, and a bespoke panel carries
 * the one knob with a hint the generic catalog select cannot give — the
 * runtime registry's defaultProps now mirror `look`, so the SpecPanel
 * fallback would also work, but this registration wins in the registry.
 */
export default function ContainerInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <SelectField
                label="Look"
                value={props.look ?? 'plain'}
                onChange={(v) => patch({ look: v })}
                options={LOOKS}
                hint="Plain is invisible — the others give the grouping a face without a card."
                disabled={disabled}
            />
        </div>
    );
}

registerInspector('container', ContainerInspector);
