import { useHasQueryClient } from '../../runtime/components/comboBox';
import { SpecField, useCatalogComponents } from './SpecPanel';
import type { PropSpec } from './SpecPanel';
import type { AppDefinition, AppNode } from '../appDefinition';

/**
 * The props a type gained after the base (marked `since` 3 or later in the
 * server catalog), each rendered from its spec the way SpecPanel renders any
 * prop. A bespoke panel puts this at its end, so a later prop is editable
 * without a hand-written control.
 *
 * An enum whose default is null (not set) offers that as its first choice, so
 * picking it clears the prop rather than writing a value.
 */

/** A spec entry as the catalog serves it, with the version it came in. */
type LaterSpec = PropSpec & { since?: number };

interface SpecLaterFieldsProps {
    node: AppNode;
    definition: AppDefinition;
    patch: (p: Record<string, unknown>) => void;
    disabled?: boolean;
}

function withUnset(fs: LaterSpec): LaterSpec {
    if (fs.type !== 'enum' || fs.default != null || (fs.values || []).includes(null)) return fs;
    return { ...fs, values: [null, ...(fs.values || [])] };
}

/** The catalog is a react-query read; a panel rendered without a query client has no later props to show. */
export default function SpecLaterFields(props: SpecLaterFieldsProps) {
    return useHasQueryClient() ? <LaterFields {...props} /> : null;
}

function LaterFields({ node, definition, patch, disabled = false }: SpecLaterFieldsProps) {
    const catalog = useCatalogComponents();
    const specs = (catalog?.[node.type]?.props || {}) as Record<string, LaterSpec>;
    const later = Object.entries(specs).filter(([, fs]) => typeof fs.since === 'number' && fs.since >= 3);
    if (!later.length) return null;
    return (
        <>
            {later.map(([key, fs]) => (
                <SpecField
                    key={key}
                    propKey={key}
                    fs={withUnset(fs)}
                    value={node.props?.[key]}
                    patch={patch}
                    definition={definition}
                    node={node}
                    disabled={disabled}
                />
            ))}
        </>
    );
}
