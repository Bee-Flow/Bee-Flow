import type { SettingsFieldSpec, SettingsGroupSpec } from './settingsLayout';

export type { SettingsForm } from './settingsLayout';

/** One answer of a select / chips field. */
export interface SettingsOption {
    value: string;
    key: string;
    en: string;
}

/** A field of the table below: the layout fields (settingsLayout.ts) plus what the form renders. */
export interface SettingsFieldDef extends SettingsFieldSpec {
    labelKey: string;
    labelEn: string;
    hintKey?: string;
    hintEn?: string;
    placeholder?: string;
    options?: readonly SettingsOption[];
    min?: number;
    max?: number;
    /** Toggles: an absent value reads as on. */
    defaultOn?: boolean;
    actionKey?: string;
    actionEn?: string;
    setKey?: string;
    setEn?: string;
    unsavedKey?: string;
    unsavedEn?: string;
    unsetKey?: string;
    unsetEn?: string;
}

export interface SettingsGroupDef extends SettingsGroupSpec {
    framework?: string;
    titleKey: string;
    titleEn: string;
    descKey: string;
    descEn: string;
    fields: readonly Readonly<SettingsFieldDef>[];
}

export interface Contact {
    name?: unknown;
    email?: unknown;
    entity?: unknown;
}
