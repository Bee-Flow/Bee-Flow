// Typed doors into the Studio primitives that are still plain JavaScript.
//
// TypeScript reads a .jsx component's destructured props as REQUIRED, so a
// .tsx caller could not leave out a single optional slot. These declarations
// state the props the components actually document (see each file's
// docblock) and re-export the same component objects: no wrapper, no second
// implementation.

import type React from 'react';
import DangerZoneJsx from '../../shared/DangerZone';
import FilterPillsJsx from '../../shared/FilterPills';
import StudioSectionHeaderJsx from '../../shared/StudioSectionHeader';
import { RequireTier as RequireTierJsx } from '../../licensing/LicenseContext';

type Glyph = React.ComponentType<Record<string, unknown>> | React.ReactElement;

export interface StudioSectionHeaderTab {
    id: string;
    label: React.ReactNode;
    count?: number | null;
    tone?: 'neutral' | 'error' | 'warning';
    icon?: Glyph;
    disabled?: boolean;
}

export interface StudioSectionHeaderProps {
    kind?: string;
    icon?: Glyph;
    title?: React.ReactNode;
    onRename?: (next: string) => void;
    renameRequest?: number;
    statusChip?: React.ReactNode;
    tabs?: StudioSectionHeaderTab[];
    activeTab?: string;
    onTab?: (id: string) => void;
    capsule?: React.ReactNode;
    primary?: React.ReactNode;
    extras?: React.ReactNode;
    onBack?: () => void;
    backLabel?: string;
    className?: string;
    testId?: string;
}

export const StudioSectionHeader = StudioSectionHeaderJsx as unknown as React.ComponentType<StudioSectionHeaderProps>;

export interface FilterPillOption<V extends string> {
    value: V;
    label: React.ReactNode;
    count?: number | null;
    tone?: 'neutral' | 'success' | 'warning' | 'error' | 'muted';
    disabled?: boolean;
    title?: string;
}

export interface FilterPillsProps<V extends string> {
    value: V;
    onChange: (value: V) => void;
    options: FilterPillOption<V>[];
    ariaLabel?: string;
    className?: string;
    testId?: string;
}

export const FilterPills = FilterPillsJsx as unknown as <V extends string>(props: FilterPillsProps<V>) => React.ReactElement;

export interface DangerZoneProps {
    entityName: string;
    /** null = still checking, [] = nothing depends on it. */
    usage: unknown[] | null;
    onDelete: (confirmedBreaking: boolean) => Promise<unknown> | unknown;
    kindLabel?: string;
    currentUserId?: string | null;
    notice?: React.ReactNode;
    openLabel?: string;
    requireName?: boolean;
    question?: string;
    confirmLabel?: string;
    className?: string;
}

export const DangerZone = DangerZoneJsx as unknown as React.ComponentType<DangerZoneProps>;

export const RequireTier = RequireTierJsx as unknown as React.ComponentType<{
    feature?: string;
    tier?: string;
    children: React.ReactNode;
    fallback?: React.ReactNode;
}>;
