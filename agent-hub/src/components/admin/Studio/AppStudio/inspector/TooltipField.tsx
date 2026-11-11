import useTranslation from '@/hooks/useTranslation';
import { TextField } from './panels/kit';
import { deepClone, findNode } from '../state/definitionOps';
import type { AppDefinition, AppNode } from './appDefinition';

/**
 * The tooltip of one component (`node.tooltip`, schema 3, runtime/NodeTooltip.tsx): a short
 * plain text shown on hover and keyboard focus. An empty field removes the key.
 */

/** The longest tooltip; the server's MAX_TOOLTIP_LEN (componentSpecs/tooltipKey.js). */
export const TOOLTIP_MAX = 200;

/** The definition with `nodeId`'s tooltip set, or removed for an empty text. */
export function setNodeTooltip(definition: AppDefinition, nodeId: string, text: string): AppDefinition {
    const next = deepClone(definition);
    const node = findNode(next, nodeId)?.node as AppNode | undefined;
    if (!node) return definition;
    const clean = text.slice(0, TOOLTIP_MAX);
    if (clean.trim()) node.tooltip = clean;
    else delete node.tooltip;
    return next;
}

interface Props {
    definition: AppDefinition;
    node: AppNode;
    onCommit: (definition: AppDefinition) => void;
    disabled: boolean;
}

export default function TooltipField({ definition, node, onCommit, disabled }: Props) {
    const { t } = useTranslation();
    const stored = typeof node.tooltip === 'string' ? node.tooltip : '';
    return (
        <div className="mt-4" data-testid="app-tooltip-field">
            <TextField
                label={t('studio_apps_lk20.tooltip.label', 'Tooltip')}
                value={stored}
                onChange={(text) => onCommit(setNodeTooltip(definition, node.id, text))}
                placeholder={t('studio_apps_lk20.tooltip.placeholder', 'What this does, in a few words')}
                disabled={disabled}
                hint={t('studio_apps_lk20.tooltip.hint', 'Shown on hover and keyboard focus. Plain text, at most {max} characters.', { max: TOOLTIP_MAX })}
            />
        </div>
    );
}
