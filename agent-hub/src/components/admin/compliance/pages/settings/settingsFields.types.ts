/**
 * settingsFields.types — the shapes of the declarative settings form table.
 */

import type { SettingsFieldSpec, SettingsGroupSpec, SettingsSectionSpec } from './settingsLayout';

/** A plain `{ value, key, en }` option of a select or a chip set. */
export interface SettingsOption {
    value: string;
    key: string;
    en: string;
}

/** One field of the settings form, as declared below. */
export interface SettingsFieldDef extends SettingsFieldSpec {
    labelKey: string;
    labelEn: string;
    hintKey?: string;
    hintEn?: string;
    placeholder?: string;
    min?: number;
    defaultOn?: boolean;
    options?: readonly SettingsOption[];
    actionKey?: string;
    actionEn?: string;
    unsetKey?: string;
    unsetEn?: string;
    unsavedKey?: string;
    unsavedEn?: string;
    setKey?: string;
    setEn?: string;
    [key: string]: unknown;
}

/** One collapsible group of the form. */
export interface SettingsGroupDef extends SettingsGroupSpec {
    framework?: string;
    titleKey: string;
    titleEn: string;
    descKey: string;
    descEn: string;
    sections?: readonly SettingsSectionSpec[];
    fields: readonly SettingsFieldDef[];
    [key: string]: unknown;
}
