import useTranslation from '@/hooks/useTranslation';
import { deepClone, findNode, newId } from '../state/definitionOps';
import type { AppDefinition, AppNode } from './appDefinition';

/**
 * The item template of a list or a kanban (schema 3, runtime/itemTemplate.tsx): its children,
 * drawn once per row or card with `item` in scope. Switching it on gives the node one text that
 * writes the row's title, which the author then edits on the canvas like any other node;
 * switching it off removes the children and the built-in body is back.
 */

const HOSTS = new Set(['list', 'kanban']);

/** The definition with `nodeId`'s template set to a starter text, or removed. */
export function setItemTemplate(definition: AppDefinition, nodeId: string, on: boolean): AppDefinition {
    const next = deepClone(definition);
    const node = findNode(next, nodeId)?.node as AppNode | undefined;
    if (!node) return definition;
    if (!on) {
        delete node.children;
        return next;
    }
    const titleKey = typeof node.props?.titleKey === 'string' && node.props.titleKey ? node.props.titleKey : 'title';
    const starter: AppNode = { id: newId('component'), type: 'text', visible: true, props: { text: 'Item' }, style: { span: 12 }, computed: { text: { kind: 'formula', expr: `item.${titleKey}` } } };
    node.children = [starter];
    return next;
}

interface Props {
    definition: AppDefinition;
    node: AppNode;
    onCommit: (definition: AppDefinition) => void;
    disabled: boolean;
}

export default function ItemTemplateField({ definition, node, onCommit, disabled }: Props) {
    const { t } = useTranslation();
    if (!HOSTS.has(node.type)) return null;
    const on = Array.isArray(node.children) && node.children.length > 0;
    return (
        <div className="mt-4 flex flex-col gap-1" data-testid="app-item-template-field">
            <label className="inline-flex items-center gap-2 text-sm text-[var(--text-primary)]">
                <input
                    type="checkbox"
                    checked={on}
                    disabled={disabled}
                    onChange={(e) => onCommit(setItemTemplate(definition, node.id, e.target.checked))}
                />
                {node.type === 'kanban'
                    ? t('studio_apps_lk20.template.card_label', 'Design the card yourself')
                    : t('studio_apps_lk20.template.row_label', 'Design the row yourself')}
            </label>
            <p className="text-xs text-[var(--text-muted)]">
                {on
                    ? t('studio_apps_lk20.template.on_hint', 'The components inside are drawn once per item. Use item.<field> in their formulas. Switching this off removes them.')
                    : t('studio_apps_lk20.template.off_hint', 'Draw each item with your own components instead of the built-in layout.')}
            </p>
        </div>
    );
}
