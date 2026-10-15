/**
 * App Studio inspector — per-type Content-panel registry.
 *
 * Mirrors the AITasksDesigner settings registry pattern
 * (admin/AITasksDesigner/Builder/flow/settings/registry.js): each panel file
 * under ./panels/ calls registerInspector(type, Component) at module scope,
 * and panels/index.js imports them all so a single side-effect import
 * (`import './panels'`) self-registers the whole catalog.
 *
 * Types WITHOUT a bespoke panel fall back to the generic SpecPanel, which
 * renders its controls from the server catalog's prop specs — so a new
 * catalog type is editable without writing a panel. Only prop-less types
 * (divider — its sole editing surface is Style) get no Content panel; the
 * InspectorPanel skips the Content accordion in that case. NB: "prop-less"
 * is judged from the runtime registry's defaultProps, so a type only gets
 * the fallback once its spec props are mirrored there (container grew
 * `look` in the look pass — it has a bespoke panel regardless).
 */

import type { ComponentType } from 'react';
import type { AppDefinition, AppNode } from './appDefinition';
import SpecPanel from './panels/SpecPanel';
import { getComponentEntry } from '../runtime/componentRegistry';

/** What the inspector hands every per-type Content panel. */
export interface InspectorPanelProps {
    node: AppNode;
    definition: AppDefinition;
    onCommit: (definition: AppDefinition) => void;
    disabled?: boolean;
}

export type InspectorPanel = ComponentType<InspectorPanelProps>;

const REGISTRY: Record<string, InspectorPanel> = {};

export function registerInspector(type: string, component: InspectorPanel) {
    REGISTRY[type] = component;
}

export function getInspectorForType(type: string): InspectorPanel | null {
    if (REGISTRY[type]) return REGISTRY[type];
    // Fallback: catalog-driven generic panel — but only for types that have
    // props to edit (and that the registry knows at all).
    const entry = getComponentEntry(type);
    if (!entry || Object.keys(entry.defaultProps || {}).length === 0) return null;
    return SpecPanel;
}

export default REGISTRY;
