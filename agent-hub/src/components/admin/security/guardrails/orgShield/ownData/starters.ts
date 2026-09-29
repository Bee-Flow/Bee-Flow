import type { LucideIcon } from 'lucide-react';
import { Hash, List, Pencil, Sparkles } from 'lucide-react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import { placeholderOf } from './ownDataCopy';
import type { CustomDataType, Method } from './ownDataModel';
import { LIMITS, emptyType, suggestTokenKey } from './ownDataModel';
import { emptyTests } from './testBench';
import type { WizardInit } from './useTypeWizard';

/**
 * The four ways into the wizard from an empty "Your own data" tab, and what
 * each one fills in. A starter only prefills; the admin still names, tests
 * and applies the type, so nothing here can add a type by itself.
 */

export type StarterId = 'projects' | 'numbers' | 'words' | 'other';

type Copy = readonly [key: string, fallback: string];

export interface Starter {
    id: StarterId;
    /** null: the admin picks how it is found in the wizard's first step. */
    method: Method | null;
    Icon: LucideIcon;
    label: Copy;
    hint: Copy;
    /** Made-up sample values, shown on the tile. Never sent anywhere. */
    example?: Copy;
    /** Drawn as the open-ended choice (a dashed tile). */
    open?: boolean;
}

export const STARTERS: readonly Starter[] = [
    {
        id: 'projects',
        method: 'ai',
        Icon: Sparkles,
        label: ['shield_data.starter_projects', 'Project code names'],
        hint: ['shield_data.starter_projects_hint', 'Recognised by AI, even new ones.'],
        example: ['shield_data.starter_projects_example', 'AURORA, NOVA-7'],
    },
    {
        id: 'numbers',
        method: 'pattern',
        Icon: Hash,
        label: ['shield_data.starter_numbers', 'Customer or contract numbers'],
        hint: ['shield_data.starter_numbers_hint', 'A pattern, like two letters and four digits.'],
        example: ['shield_data.starter_numbers_example', 'KC-2291, KC-0412'],
    },
    {
        id: 'words',
        method: 'words',
        Icon: List,
        label: ['shield_data.starter_words', 'A list of names or words'],
        hint: ['shield_data.starter_words_hint', 'Type or paste, one per line.'],
        example: ['shield_data.starter_words_example', 'De Vries Bouw'],
    },
    {
        id: 'other',
        method: null,
        Icon: Pencil,
        label: ['shield_data.starter_describe', 'Describe it in your words'],
        hint: ['shield_data.starter_describe_hint', 'Name it and say what it looks like. You can test it before you use it.'],
        open: true,
    },
];

/** The name and description a starter fills in. Starters without one open blank. */
const STARTER_TEXT: Partial<Record<StarterId, { name: Copy; desc: Copy }>> = {
    projects: {
        name: ['shield_data.starter_projects_name', 'Project code names'],
        desc: ['shield_data.starter_projects_desc', 'The names we give our internal projects. Usually one or two words.'],
    },
    numbers: {
        name: ['shield_data.starter_numbers_name', 'Customer numbers'],
        desc: ['shield_data.starter_numbers_desc', 'Our customer numbers. They always have the same format.'],
    },
};

/**
 * The placeholder a starter's type would get, worked out the same way the
 * wizard does, so the tile shows what the AI would really read. Null for a
 * starter that opens without a name: it has no placeholder yet.
 */
export function starterPlaceholder(starter: StarterId, types: readonly CustomDataType[], t: TranslateFn): string | null {
    const text = STARTER_TEXT[starter];
    return text ? placeholderOf(suggestTokenKey(t(...text.name), types)) : null;
}

/**
 * The wizard's opening state for a starter. `description` is what the admin
 * typed under "Or describe it"; it replaces the starter's own description and
 * is clipped to what the wizard accepts.
 */
export function starterInit(
    starter: StarterId,
    types: CustomDataType[],
    canBlockExternal: boolean,
    t: TranslateFn,
    description?: string,
): WizardInit {
    const def = STARTERS.find(s => s.id === starter) || STARTERS[STARTERS.length - 1];
    const type = emptyType(def.method || 'words');
    const text = STARTER_TEXT[starter];
    if (text) {
        type.name = t(...text.name);
        type.description = t(...text.desc);
        type.tokenKey = suggestTokenKey(type.name, types, type);
    }
    const own = (description || '').trim();
    if (own) type.description = own.slice(0, LIMITS.description);
    return {
        mode: 'new',
        type,
        tests: emptyTests(),
        apply: { detect: true, external: canBlockExternal, internal: false },
        methodChosen: !!def.method,
    };
}
