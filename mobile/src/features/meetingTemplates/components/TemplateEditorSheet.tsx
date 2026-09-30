/**
 * Create or edit one summary template: the port of agent-hub
 * TemplateEditor.jsx — name, "start from a built-in" (new only), the prompt,
 * who sees it (new only), and whether new meetings use it by default.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { translate, useTranslation, type TranslateFn } from '@/core/i18n';
import { FormSheet } from '@/shared/patterns';
import { Button, Chip, Text, TextField, ToggleRow } from '@/shared/ui';

import { ScopePicker } from './ScopePicker';
import { useTemplateEditor } from '../hooks/useTemplateEditor';
import { MAX_NAME_LENGTH, MAX_PROMPT_LENGTH } from '../model/draft';
import type { SummaryTemplate, TemplateGroup, TemplateScope } from '../model/types';

const styles = StyleSheet.create({
    stack: { gap: 6 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});

function defaultHint(scope: TemplateScope, t: TranslateFn): string {
    if (scope === 'org') {
        return t(
            'meeting_notes.template_default_org_hint',
            'New meetings in your organization get this style unless a member or group default overrides it.',
        );
    }
    if (scope === 'group') {
        return t(
            'meeting_notes.template_default_group_hint',
            "New meetings by this group's members get this style unless they set a personal default.",
        );
    }
    return t(
        'meeting_notes.template_default_user_hint',
        'New meetings you create get this summary style automatically.',
    );
}

function SeedChips({ builtins, onSeed }: { builtins: readonly SummaryTemplate[]; onSeed: (b: SummaryTemplate) => void }) {
    const t = useTranslation();
    if (!builtins.length) return null;
    return (
        <View style={styles.stack}>
            <Text variant="label" tone="secondary">
                {t('meeting_notes.template_start_from', 'Start from a built-in (optional)')}
            </Text>
            <View style={styles.chips}>
                {builtins.map((b) => (
                    <Chip key={b.id} label={b.nameKey ? translate(b.nameKey, b.name) : b.name} onPress={() => onSeed(b)} />
                ))}
            </View>
        </View>
    );
}

export interface TemplateEditorSheetProps {
    visible: boolean;
    /** Null for a new template. */
    template: SummaryTemplate | null;
    builtins: readonly SummaryTemplate[];
    canManageOrg: boolean;
    groups: readonly TemplateGroup[];
    onClose: () => void;
    /** Where a new template starts: the org admin's panel starts on the organisation. */
    defaultScope?: TemplateScope;
}

export function TemplateEditorSheet({
    visible,
    template,
    builtins,
    canManageOrg,
    groups,
    onClose,
    defaultScope = 'user',
}: TemplateEditorSheetProps) {
    const t = useTranslation();
    const editor = useTemplateEditor(template, visible, onClose, defaultScope);
    const { form } = editor;
    const { scope, groupId, isDefault } = form.values;
    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title={
                template
                    ? t('meeting_notes.template_edit_title', 'Edit template')
                    : t('meeting_notes.template_new_title', 'New summary template')
            }
            subtitle={t(
                'meeting_notes.template_editor_desc',
                'Write the instructions the AI follows when it generates this summary style.',
            )}
            submitLabel={t('meeting_notes.template_save', 'Save template')}
            onSubmit={() => void editor.submit()}
            canSubmit={editor.ready && form.canSubmit && !editor.deleting}
            submitting={form.submitting}
            error={editor.error}
            cancelLabel={t('meeting_notes.template_cancel', 'Cancel')}
        >
            <TextField
                label={t('meeting_notes.template_name', 'Name')}
                placeholder={t('meeting_notes.template_name_ph', 'e.g. Board summary, Klant-review NL')}
                maxLength={MAX_NAME_LENGTH}
                {...form.field('name')}
            />
            {template ? null : <SeedChips builtins={builtins} onSeed={editor.seed} />}
            <TextField
                label={t('meeting_notes.template_prompt', 'Prompt')}
                placeholder={t(
                    'meeting_notes.template_prompt_ph',
                    'Describe the summary you want — sections, tone, what to focus on…',
                )}
                multiline
                maxLines={10}
                maxLength={MAX_PROMPT_LENGTH}
                {...form.field('prompt')}
            />
            {template ? (
                <Text variant="caption" tone="tertiary">
                    {t('meeting_notes.template_scope_locked', "Scope can't be changed after creation.")}
                </Text>
            ) : (
                <ScopePicker
                    scope={scope}
                    groupId={groupId}
                    canManageOrg={canManageOrg}
                    groups={groups}
                    onScope={(next) => form.set('scope', next)}
                    onGroup={(next) => form.set('groupId', next)}
                />
            )}
            <ToggleRow
                gutter={false}
                label={t('meeting_notes.template_set_default', 'Use as the default for new meetings')}
                description={defaultHint(scope, t)}
                value={isDefault}
                onValueChange={(next) => form.set('isDefault', next)}
            />
            {template ? (
                <Button
                    label={t('meeting_notes.template_delete', 'Delete')}
                    variant="danger"
                    iconName="Trash2"
                    loading={editor.deleting}
                    onPress={() => void editor.destroy()}
                />
            ) : null}
        </FormSheet>
    );
}
