// Types for the Compliance Center registry (sections.js), so TypeScript
// callers see its real shapes instead of the literal types inferred from the
// frozen tables.
import type { LucideIcon } from 'lucide-react';

/** A section's `legacyTabs` target: the section and tab a moved `?tab=` lands on. */
export interface MovedTab {
    section: string;
    tab?: string | null;
}

/** One entry of the Compliance Center registry. */
export interface SectionDef {
    id: string;
    group: string | null;
    icon: LucideIcon;
    labelKey: string;
    labelFallback: string;
    regulation: string | null;
    tabs: readonly string[];
    aliases: readonly string[];
    legacyTabs: Readonly<Record<string, MovedTab>>;
    optional?: boolean;
    [key: string]: unknown;
}

/** A rail group (KADERS · REGISTERS · BEHEER). */
export interface GroupDef {
    id: string;
    labelKey: string;
    labelFallback: string;
    [key: string]: unknown;
}

export const GROUPS: readonly GroupDef[];
export const SECTIONS: readonly SectionDef[];
export const DEFAULT_SECTION: string;
export function resolveSection(id: unknown): string;
export function sectionById(id: unknown): SectionDef;
export function frameworkOf(sectionId: string | null | undefined): string | null;
export const SECTION_FOR_REGULATION: Readonly<Record<string, string>>;
export function sectionForRegulation(code: string | null | undefined): string;
export function tabsOf(sectionId: string | null | undefined): readonly string[];
export function resolveTab(sectionId: string, tab: string | null | undefined): { section: string; tab: string | null };
export function movedTab(sectionId: string, tab: string | null | undefined): MovedTab | null;
export function sectionsInGroup(groupId: string): SectionDef[];
export const SECTIONS_WITH_PICKERS: readonly string[];
export function tabLabelKey(sectionId: string, tabId: string): string;
