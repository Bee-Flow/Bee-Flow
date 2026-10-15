/**
 * SettingsGroup.types — the props and the shared shapes of one settings group
 * card (SettingsGroup.tsx): the page's props, the form field props and the
 * contact row.
 */
import type { ReactNode } from 'react';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import type { OrgUser } from '../../shared/UserPicker';
import type { SettingsForm } from './settingsLayout';
import type { SettingsGroupDef } from './settingsFields.types';

/** A contact of the contacts list. */
export interface ContactRow {
    name?: string;
    email?: string;
    entity?: string;
    [key: string]: unknown;
}

/** The value a field's onChange is called with. */
export type ChangeFn = (name: string, value: unknown) => void;

/** What every group field needs from the page. */
export interface FieldProps {
    form: SettingsForm | null | undefined;
    saved: SettingsForm | null | undefined;
    onChange: ChangeFn;
    orgUsers: OrgUser[] | null | undefined;
    relevanceOf: (name: string) => string;
    onRelevance: ((name: string, value: string) => void) | null | undefined;
    t: TranslateFn;
    locale: string;
}

export interface SettingsGroupProps {
    group: SettingsGroupDef;
    form: SettingsForm | null | undefined;
    saved?: SettingsForm | null;
    onChange: ChangeFn;
    orgUsers?: OrgUser[] | null;
    open?: boolean;
    onToggle?: ((next: boolean) => void) | null;
    inactive?: boolean;
    relevanceOf?: (name: string) => string;
    onRelevance?: ((name: string, value: string) => void) | null;
    sectionFooters?: Record<string, ReactNode> | null;
}
