import type { TranslateParams } from '@/hooks/useTranslation';
import type { OrgUser } from '../accessAuditLabels';
import type { Contact, SettingsGroupDef, SettingsFieldDef } from './settingsFields.types';
import type { SettingsForm, SettingsSection } from './settingsLayout';
import type React from 'react';

/**
 * SettingsGroup — one collapsible card of the compliance settings form.
 *
 * It renders the field table from `settingsFields.js`; the page owns the form
 * state and the save. The header says how far the group is answered
 * (settingsLayout.groupProgress). The body is a container-queried grid: one
 * column on a narrow card, six tracks from 640px, where a field takes a
 * third, half or the whole row (settingsLayout.spanOf), so short inputs sit
 * side by side. A group with `sections` gets a sub-heading per section; a
 * `userfill` field sits in its section's heading row as a compact picker.
 *
 * `saved` is the form as last loaded or saved: the AI-literacy stamp reads
 * "not saved yet" only while it differs from it. A group whose framework is
 * off is not hidden: the page lists it under one "Frameworks that are off"
 * disclosure (locked ≠ invisible, PLAN §1.4).
 */
export type Translate = (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;

/** A member picked to fill the DPO fields: the directory row, with the phone the page copies. */
export type MemberValue = OrgUser & { phone?: string | null };

export type SettingsValue = string | boolean | MemberValue | (string | Contact)[];

export type SettingsChange = (name: string, value: SettingsValue) => void;

export type RelevanceSetter = (frameworkId: string, value: string) => unknown;

/** What the group hands down to its sections and fields. */
export interface FieldProps {
    form: SettingsForm;
    saved: SettingsForm | null;
    onChange: SettingsChange;
    orgUsers: OrgUser[] | null;
    relevanceOf: (frameworkId: string) => string;
    onRelevance: RelevanceSetter | null;
    t: Translate;
    locale: string;
}

export interface SettingsGroupProps {
    group: Readonly<SettingsGroupDef>;
    onChange: SettingsChange;
    orgUsers?: OrgUser[] | null;
    onToggle?: ((open: boolean) => void) | null;
    onRelevance?: RelevanceSetter | null;
    form: SettingsForm;
    saved?: SettingsForm | null;
    open?: boolean;
    inactive?: boolean;
    relevanceOf?: (frameworkId: string) => string;
    sectionFooters?: Record<string, React.ReactNode> | null;
}

/** One section of a group: its sub-heading (with any member picker), the grid of fields, an optional footer. */
export interface GroupSectionProps {
    section: SettingsSection;
    first: boolean;
    footer?: React.ReactNode | null;
    fieldProps: FieldProps;
}

/** "Fill from member": a compact picker in the heading row that copies a member's name, e-mail and phone. */
export interface MemberFillProps {
    field: SettingsFieldDef;
    orgUsers?: OrgUser[] | null;
    onChange: SettingsChange;
    t: Translate;
}

export interface GroupFieldProps extends FieldProps {
    field: SettingsFieldDef;
}

export interface RemoveButtonProps {
    onClick: React.MouseEventHandler<HTMLButtonElement>;
    label: string;
    testId: string;
}

/** A string, or the detector's `{id,label,note}` shape. */
export type ListEntry = string | (Contact & { label?: string; id?: string });

export interface StringListProps {
    label: string;
    hint: string | null;
    value: unknown;
    onChange: (next: ListEntry[]) => void;
    placeholder?: string;
    testId: string;
    t: Translate;
}

export interface ContactRow { name?: string; email?: string; entity?: string }

export interface ContactListProps {
    label: string;
    hint: string | null;
    value: unknown;
    onChange: (next: ContactRow[]) => void;
    testId: string;
    t: Translate;
}

/** The framework-relevance answer — it is NOT a settings column; it goes to `frameworks.setRelevance`. */
export interface RelevanceFieldProps {
    field: SettingsFieldDef;
    relevanceOf: (frameworkId: string) => string;
    onRelevance: RelevanceSetter | null;
    t: Translate;
}
