// Typed doors into the Studio primitives the project pages use.
//
// StudioSectionHeader and DangerZone are still plain JavaScript: TypeScript
// reads a .jsx component's destructured props as REQUIRED, so a .tsx caller
// could not leave out a single optional slot. Their declarations below state
// the props the components document (see each file's docblock) and re-export
// the same component objects: no wrapper, no second implementation.
// FilterPills and RequireTier are TypeScript and pass through as they are.

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

export const FilterPills = FilterPillsJsx;

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

export const RequireTier = RequireTierJsx;
