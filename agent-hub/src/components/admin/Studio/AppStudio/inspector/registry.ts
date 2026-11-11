/**
 * App Studio inspector — per-type Content-panel registry.
 *
 * Mirrors the AITasksDesigner settings registry pattern
 * (admin/AITasksDesigner/Builder/flow/settings/registry.js): each panel file
 * under ./panels/ calls registerInspector(type, Component, coverage) at module
 * scope, and panels/index.js imports them all so a single side-effect import
 * (`import './panels'`) self-registers the whole catalog.
 *
 * `coverage` names the props the bespoke panel edits itself (and, for a list
 * prop, the item keys its own list editor shows). Every other prop of the
 * type's catalog spec is rendered by the generic "More options" block under
 * the panel (panels/MoreOptions.tsx), so a prop the panel does not know about,
 * including one added to the spec later, is still reachable by hand.
 * panels/MoreOptions.lockstep.test.tsx holds every panel to its claim.
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
interface InspectorPanelProps {
    node: AppNode;
    definition: AppDefinition;
    onCommit: (definition: AppDefinition) => void;
    disabled?: boolean;
}

export type InspectorPanel = ComponentType<InspectorPanelProps>;

/**
 * What a bespoke panel edits itself.
 *
 * `props`: the top-level prop keys it has a control for.
 * `items`: for each list prop in `props`, the item keys its own list editor
 * has a control for, keyed by the prop (`columns`) or, for a list inside an
 * item, by its path (`fields[].options`). The keys left over are edited per
 * existing item in "More options".
 */
export interface PanelCoverage {
    props: readonly string[];
    items?: Readonly<Record<string, readonly string[]>>;
}

const REGISTRY: Record<string, InspectorPanel> = {};
const COVERAGE: Record<string, PanelCoverage> = {};

export function registerInspector(type: string, component: InspectorPanel, coverage: PanelCoverage) {
    REGISTRY[type] = component;
    COVERAGE[type] = coverage;
}

export function getInspectorForType(type: string): InspectorPanel | null {
    if (REGISTRY[type]) return REGISTRY[type];
    // Fallback: catalog-driven generic panel — but only for types that have
    // props to edit (and that the registry knows at all).
    const entry = getComponentEntry(type);
    if (!entry || Object.keys(entry.defaultProps || {}).length === 0) return null;
    return SpecPanel;
}

/** What the bespoke panel of a type edits itself (null for a type on the generic SpecPanel). */
export function getPanelCoverage(type: string): PanelCoverage | null {
    return REGISTRY[type] ? COVERAGE[type] ?? null : null;
}

export default REGISTRY;
