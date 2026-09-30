/**
 * Simple / All options — how MUCH of a step's form shows. The pure half of the
 * web's flow/settings/formDensity.js (which also holds a React context, so it
 * cannot be required here); pinned by density.lockstep.test.ts.
 *
 * In Simple, a section is left out when the type's nodeDefs `simpleSections`
 * excludes it; a type with no such list falls back to the global rule
 * (ADVANCED_SECTION_KEYS). A section holding a validation error, or one the
 * author has already configured, is never hidden — hiding a thing that is
 * switched on reads as data loss.
 */

import { nodeDef } from '@/features/flow-editor/model';

import type { FormMode } from '../editors/types';

export const FORM_MODES: readonly FormMode[] = ['simple', 'advanced'];

export const ADVANCED_SECTION_KEYS: ReadonlySet<string> = new Set(['advanced', 'options', 'headers', 'auth', 'output']);

export function isAdvancedSection(sectionKey: string): boolean {
    return ADVANCED_SECTION_KEYS.has(sectionKey);
}

/** Is this section hidden for this step type in Simple mode? */
export function hiddenInSimple(stepType: string, sectionKey: string): boolean {
    const simple = nodeDef(stepType)?.simpleSections;
    if (Array.isArray(simple)) return !simple.includes(sectionKey);
    return isAdvancedSection(sectionKey);
}

/** Does this section render at all, in this mode? */
export function sectionShown(
    stepType: string,
    sectionKey: string,
    { mode, hasError = false, hasContent = false }: { mode: FormMode; hasError?: boolean; hasContent?: boolean },
): boolean {
    if (mode !== 'simple') return true;
    return !hiddenInSimple(stepType, sectionKey) || hasError || hasContent;
}

/** How many sections of a type Simple leaves out ("Show all options (n)"). */
export function hiddenSectionCount(stepType: string, sectionKeys: readonly string[]): number {
    return sectionKeys.filter((k) => hiddenInSimple(stepType, k)).length;
}
