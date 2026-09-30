// The fields that say what a project IS — name, description, icon, colour,
// instructions — shared by the create form and the Settings tab so the two
// can never disagree about a limit or a choice.

import { Check } from 'lucide-react';
import React, { useId } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import FormField from '../../shared/FormField';
import { safeProjectColor, swatchStyle } from './projectVisuals';
import { CharCount, INPUT_CLASS } from './workspaceUi';

// Mirrors of the server's caps (routes/projects/schemas.js), so the form
// answers before a 400 does.
export const MAX_NAME = 120;
export const MAX_DESCRIPTION = 1000;
export const MAX_INSTRUCTIONS = 8000;

const ICON_OPTIONS = [
    { emoji: '📁', labelKey: 'project_home.icon.folder', label: 'Folder' },
    { emoji: '🚀', labelKey: 'project_home.icon.rocket', label: 'Rocket' },
    { emoji: '💡', labelKey: 'project_home.icon.idea', label: 'Light bulb' },
    { emoji: '🎯', labelKey: 'project_home.icon.target', label: 'Target' },
    { emoji: '📊', labelKey: 'project_home.icon.chart', label: 'Chart' },
    { emoji: '🔬', labelKey: 'project_home.icon.research', label: 'Microscope' },
    { emoji: '🎨', labelKey: 'project_home.icon.design', label: 'Palette' },
    { emoji: '📝', labelKey: 'project_home.icon.notes', label: 'Notepad' },
    { emoji: '🏗️', labelKey: 'project_home.icon.build', label: 'Construction' },
    { emoji: '⚡', labelKey: 'project_home.icon.bolt', label: 'Lightning' },
    { emoji: '🤝', labelKey: 'project_home.icon.team', label: 'Handshake' },
    { emoji: '📚', labelKey: 'project_home.icon.books', label: 'Books' },
];

// Only hues the product palette allows (see the palette tests under admin/Studio).
const COLOR_OPTIONS = [
    { hex: '#3b82f6', labelKey: 'project_home.color.blue', label: 'Blue' },
    { hex: '#0ea5e9', labelKey: 'project_home.color.sky', label: 'Sky' },
    { hex: '#14b8a6', labelKey: 'project_home.color.teal', label: 'Teal' },
    { hex: '#22c55e', labelKey: 'project_home.color.green', label: 'Green' },
    { hex: '#f59e0b', labelKey: 'project_home.color.amber', label: 'Amber' },
    { hex: '#f97316', labelKey: 'project_home.color.orange', label: 'Orange' },
    { hex: '#f43f5e', labelKey: 'project_home.color.rose', label: 'Rose' },
    { hex: '#ec4899', labelKey: 'project_home.color.pink', label: 'Pink' },
    { hex: '#64748b', labelKey: 'project_home.color.slate', label: 'Slate' },
];

interface FieldProps<T> {
    value: T;
    onChange: (next: T) => void;
    disabled?: boolean;
}

export function NameField({ value, onChange, disabled, autoFocus, error }: FieldProps<string> & { autoFocus?: boolean; error?: string | null }) {
    const { t } = useTranslation();
    const id = useId();
    return (
        <FormField label={t('project_home.field.name', 'Name')} htmlFor={id} error={error || undefined}>
            <input
                id={id}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                maxLength={MAX_NAME}
                disabled={disabled}
                autoFocus={autoFocus}
                placeholder={t('project_home.field.name_placeholder', 'For example: Website relaunch')}
                className={INPUT_CLASS}
                data-testid="project-field-name"
            />
        </FormField>
    );
}

export function DescriptionField({ value, onChange, disabled }: FieldProps<string>) {
    const { t } = useTranslation();
    const id = useId();
    return (
        <FormField
            label={t('project_home.field.description', 'Description')}
            htmlFor={id}
            trailing={<CharCount value={value} max={MAX_DESCRIPTION} />}
        >
            <textarea
                id={id}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                maxLength={MAX_DESCRIPTION}
                disabled={disabled}
                rows={2}
                placeholder={t('project_home.field.description_placeholder', 'What is this project about?')}
                className={`${INPUT_CLASS} resize-y`}
                data-testid="project-field-description"
            />
        </FormField>
    );
}

export function InstructionsField({ value, onChange, disabled, rows = 6 }: FieldProps<string> & { rows?: number }) {
    const { t } = useTranslation();
    const id = useId();
    return (
        <FormField
            label={t('project_home.field.instructions', 'Instructions for the AI')}
            htmlFor={id}
            description={t('project_home.field.instructions_help', 'Added to every AI chat in this project: tone, context, what to keep in mind.')}
            trailing={<CharCount value={value} max={MAX_INSTRUCTIONS} />}
        >
            <textarea
                id={id}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                maxLength={MAX_INSTRUCTIONS}
                disabled={disabled}
                rows={rows}
                placeholder={t('project_home.field.instructions_placeholder', 'For example: Answer in plain language. Our audience is small business owners.')}
                className={`${INPUT_CLASS} resize-y font-mono text-[13px]`}
                data-testid="project-field-instructions"
            />
        </FormField>
    );
}

export function IconPicker({ value, onChange, disabled }: FieldProps<string>) {
    const { t } = useTranslation();
    return (
        <FormField label={t('project_home.field.icon', 'Icon')}>
            <div role="radiogroup" aria-label={t('project_home.field.icon', 'Icon')} className="flex flex-wrap gap-1.5">
                {ICON_OPTIONS.map((o) => {
                    const active = value === o.emoji;
                    return (
                        <button
                            key={o.emoji}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            aria-label={t(o.labelKey, o.label)}
                            title={t(o.labelKey, o.label)}
                            disabled={disabled}
                            onClick={() => onChange(o.emoji)}
                            className={`w-9 h-9 grid place-items-center rounded-lg text-lg border transition-colors disabled:opacity-50 ${
                                active
                                    ? 'border-[var(--accent-primary)] bg-[var(--item-active-bg)]'
                                    : 'border-[var(--border-subtle)] hover:bg-[var(--item-hover-bg)]'
                            }`}
                        >
                            <span aria-hidden="true">{o.emoji}</span>
                        </button>
                    );
                })}
            </div>
        </FormField>
    );
}

export function ColorSwatches({ value, onChange, disabled }: FieldProps<string>) {
    const { t } = useTranslation();
    const current = safeProjectColor(value).toLowerCase();
    return (
        <FormField label={t('project_home.field.color', 'Colour')}>
            <div role="radiogroup" aria-label={t('project_home.field.color', 'Colour')} className="flex flex-wrap gap-2">
                {COLOR_OPTIONS.map((o) => {
                    const active = current === o.hex;
                    return (
                        <button
                            key={o.hex}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            aria-label={t(o.labelKey, o.label)}
                            title={t(o.labelKey, o.label)}
                            disabled={disabled}
                            onClick={() => onChange(o.hex)}
                            style={swatchStyle(o.hex)}
                            className={`w-7 h-7 grid place-items-center rounded-full ring-offset-2 ring-offset-[var(--bg-card)] transition disabled:opacity-50 ${
                                active ? 'ring-2 ring-[var(--text-primary)]' : 'hover:scale-105'
                            }`}
                        >
                            {active && <Check className="w-3.5 h-3.5 text-white" aria-hidden="true" />}
                        </button>
                    );
                })}
            </div>
        </FormField>
    );
}
