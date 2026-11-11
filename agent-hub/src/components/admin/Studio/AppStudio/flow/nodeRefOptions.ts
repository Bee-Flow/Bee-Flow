/**
 * The component picker of the steps that name a node by `nodeId` (focus,
 * scroll_to, set_ui: server/appStudio/componentSpecs/steps/). Every node of the
 * app is a pick, labelled by what the author wrote on it; per step the list is
 * narrowed to what that step can act on: scroll_to also offers "Top of the
 * screen", set_ui only the components that keep the chosen state.
 */
import type { TranslateFn } from '@/hooks/useTranslation';
import type { AppDefinition, AppNode } from '../inspector/appDefinition';
import type { RefOption } from './stepReferences';

/** A node pick: the RefOption plus the component type the narrowing reads. */
export interface NodeOption extends RefOption {
    type: string;
}

/** The component type that keeps each set_ui state (the validator's uiStepChecks.mts has the same table). */
const UI_STATE_TYPES: Readonly<Record<string, string>> = Object.freeze({ activeTab: 'tabs', open: 'modal', selection: 'data_grid' });

function nodeLabel(node: AppNode): string {
    const props = (node.props || {}) as Record<string, unknown>;
    for (const key of ['label', 'title', 'heading', 'text', 'name', 'placeholder']) {
        const v = props[key];
        if (typeof v === 'string' && v.trim()) return `${v.trim().slice(0, 60)} · ${node.type}`;
    }
    return `${node.id} · ${node.type}`;
}

/** Every node with an id, in screen order (children after their parent). */
export function collectNodes(definition: AppDefinition | null | undefined): NodeOption[] {
    const out: NodeOption[] = [];
    const walk = (nodes: AppNode[] | null | undefined) => {
        for (const n of nodes || []) {
            if (n && typeof n.id === 'string' && typeof n.type === 'string') out.push({ id: n.id, label: nodeLabel(n), type: n.type });
            if (Array.isArray(n?.children)) walk(n.children);
        }
    };
    for (const screen of definition?.screens || []) {
        for (const section of screen.sections || []) walk(section.children);
    }
    return out;
}

/** The picks one step offers for its nodeId. */
export function nodeRefOptions(step: Record<string, unknown> | null | undefined, nodes: readonly RefOption[] | undefined, t: TranslateFn | null = null): RefOption[] {
    const all = (nodes || []) as readonly NodeOption[];
    if (step?.kind === 'scroll_to') {
        return [{ id: 'top', label: t ? t('studio_apps_ui_steps.refs.top', 'Top of the screen') : 'Top of the screen' }, ...all];
    }
    if (step?.kind === 'set_ui' && typeof step.state === 'string' && Object.hasOwn(UI_STATE_TYPES, step.state)) {
        const type = UI_STATE_TYPES[step.state];
        return all.filter((n) => n.type === type);
    }
    return [...all];
}
