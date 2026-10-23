import type { UpstreamGroup, GroupField } from './deepFields';
import type React from 'react';
import type { ListShape } from './listShape';

/**
 * Portal-rendered popover that lists upstream variables, filterable by
 * name/path, with a hover preview of the resolved sample value at the
 * footer. Anchored to a DOM element supplied by the caller; flips above
 * the anchor when there isn't enough room below.
 *
 * Replaces the side-panel `activeFieldRef`/`onFocusField` indirection
 * for per-field insertion: the field owns the picker, so there's no
 * stale-handle window where the previously-focused input has unmounted.
 *
 * Props:
 *   open          — whether the popover is visible
 *   anchorEl      — DOM element to anchor against (typically the {} button)
 *   groups        — variable groups from useUpstreamVariables(...)
 *   onPick(path)  — called with the bare dotted path when the user selects a leaf
 *   onClose()     — called when the user dismisses (Escape, outside click, X button)
 *   previewSample — merged sample-root tree (same one BindingField uses for
 *                   inline previews); enables the footer "preview" line
 *   title         — optional aria/dialog label
 */
export interface VariablePickerProps {
    open: boolean;
    anchorEl: HTMLElement | null;
    groups?: UpstreamGroup[];
    onPick?: (path: string, opts?: { raw?: boolean }) => void;
    onClose: () => void;
    previewSample?: unknown;
    title?: string;
    initialQuery?: string;
    focusPath?: string;
}

export interface PickerGroupProps {
    group: UpstreamGroup;
    onPick?: (path: string, opts?: { raw?: boolean }) => void;
    onHoverField: React.Dispatch<React.SetStateAction<GroupField | null>>;
    previewSample?: unknown;
    currentPath?: string;
    searching?: boolean;
}

export interface PickerLeafProps {
    field: GroupField;
    onPick?: (path: string, opts?: { raw?: boolean }) => void;
    onHoverField: React.Dispatch<React.SetStateAction<GroupField | null>>;
    depth: number;
    previewSample?: unknown;
    currentPath?: string;
    searching?: boolean;
}

/**
 * A row's name, its list badge and its example. The name has priority over
 * the other two: "Tags" must never shrink to "T…" to make room for sample text.
 */
export interface LeafTextProps {
    field: GroupField & { label?: string; labelKey?: string };
    shape: ListShape | null;
    previewSample: unknown;
    hasChildren: boolean;
}
