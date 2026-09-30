/**
 * The tools an AI step may call — the web's AiStepToolSelect and ToolPicker
 * (aiStepEditors.jsx): individual app actions, picked per app, stored as the
 * step's `tools` allowlist (allowTools follows it). A legacy step with no
 * list and allowTools on means "every permitted tool", and says so until the
 * author chooses specific tools — which starts from all of them, so nothing
 * changes until something is unticked.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { CatalogAppRow } from '@/features/flow-editor/api';
import { ToggleField } from '@/features/flow-editor/components/fields';
import { Button, Chip, Icon, Sheet, Text } from '@/shared/ui';

import { Note } from '../shared/Note';
import type { StepEditorProps } from '../types';
import { chooseSpecificTools, isLegacyAllTools, toggleApp, toggleTool, toolApps, toolLabel } from './aiModel';

function ToolSheet({ open, onClose, apps, editor }: { open: boolean; onClose: () => void; apps: CatalogAppRow[]; editor: StepEditorProps }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const selected = Array.isArray(editor.draft.tools) ? (editor.draft.tools as string[]) : [];
    return (
        <Sheet visible={open} onClose={onClose} title={t('mobile.flow.ai.tools', 'Tools')} tall>
            {apps.map((app) => {
                const names = app.actions.map((a) => a.name);
                const all = names.every((n) => selected.includes(n));
                return (
                    <View key={app.id} style={styles.app}>
                        <ToggleField value={all} onChange={(on) => editor.setMany(toggleApp(editor.draft, app, on))} label={app.label || app.id} />
                        {app.actions.map((a) => (
                            <ToggleField
                                key={a.name}
                                value={selected.includes(a.name)}
                                onChange={() => editor.setMany(toggleTool(editor.draft, a.name))}
                                label={a.label || a.name}
                                description={a.description || null}
                            />
                        ))}
                    </View>
                );
            })}
        </Sheet>
    );
}

export function ToolSelect(editor: StepEditorProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [open, setOpen] = useState(false);
    const apps = toolApps(editor.ctx.catalog);
    const selected = Array.isArray(editor.draft.tools) ? (editor.draft.tools as string[]) : [];
    const disabled = editor.ctx.disabled;
    const sheet = <ToolSheet open={open} onClose={() => setOpen(false)} apps={apps} editor={editor} />;
    if (isLegacyAllTools(editor.draft)) {
        return (
            <>
                <Chip label={t('mobile.flow.ai.all_tools', 'All available tools')} icon={<Icon name="Sparkles" size={12} color={styles.glyph.color} />} selected />
                <Button
                    size="sm"
                    variant="ghost"
                    label={t('mobile.flow.ai.choose_specific', 'Choose specific tools…')}
                    onPress={() => {
                        editor.setMany(chooseSpecificTools(apps));
                        setOpen(true);
                    }}
                    disabled={disabled}
                />
                {sheet}
            </>
        );
    }
    return (
        <>
            <Button size="sm" variant="secondary" iconName="Plus" label={t('mobile.flow.ai.browse_tools', 'Browse tools')} onPress={() => setOpen(true)} disabled={disabled} testID="ai-browse-tools" />
            {selected.length === 0 ? (
                <Note>{t('mobile.flow.ai.no_tools', 'No tools — the AI step answers from its prompt only.')}</Note>
            ) : (
                <View style={styles.chips}>
                    {selected.map((name) => (
                        <Chip
                            key={name}
                            label={toolLabel(name, apps)}
                            icon={<Icon name="X" size={12} color={styles.glyph.color} />}
                            onPress={() => editor.setMany(toggleTool(editor.draft, name))}
                            disabled={disabled}
                        />
                    ))}
                </View>
            )}
            {apps.length === 0 ? (
                <Text variant="caption" tone="tertiary">
                    {t('mobile.flow.ai.no_apps', 'No connected apps with actions are available to you.')}
                </Text>
            ) : null}
            {sheet}
        </>
    );
}

const makeStyles = (theme: Theme) => ({
    app: { gap: theme.spacing.xs, paddingVertical: theme.spacing.sm, borderBottomWidth: 1, borderBottomColor: theme.colors.borderSubtle } satisfies ViewStyle,
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs } satisfies ViewStyle,
    glyph: { color: theme.colors.textSecondary },
});
