/**
 * The routine's name and description — the top of the web's SettingsTab.
 * They go through their own call (useUpdateFlowMeta: never the definition,
 * which is the draft store's), with Save and Reset. The fields follow the
 * server again whenever nothing is typed here that is not saved yet, so an
 * AI rename or a rename on the build screen shows up without clobbering an
 * edit in progress.
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useUpdateFlowMeta } from '@/features/flow-editor/hooks';
import { Banner, Button, Group, Text, TextField, useToast } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    body: { gap: theme.spacing.md, padding: theme.spacing.lg } satisfies ViewStyle,
    actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: theme.spacing.sm } satisfies ViewStyle,
    count: { flex: 1 } satisfies ViewStyle,
});

interface Fields {
    title: string;
    description: string;
}

export function DetailsGroup({ flowKey, title, description }: { flowKey: string; title: string; description: string }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const [draft, setDraft] = useState<Fields>({ title, description });
    const dirty = draft.title !== title || draft.description !== description;
    const dirtyRef = useRef(dirty);
    useEffect(() => {
        dirtyRef.current = dirty;
    });
    useEffect(() => {
        if (!dirtyRef.current) setDraft({ title, description });
    }, [title, description]);
    const save = useUpdateFlowMeta(flowKey, { onSuccess: () => toast(t('common.saved', 'Saved'), 'success') });
    const name = draft.title.trim();
    return (
        <Group title={t('mobile.flow.settings.details', 'Details')} footer={t('mobile.flow.settings.description_hint', 'Optional. Shown to admins reviewing this automation.')}>
            <View style={styles.body}>
                {save.isError ? <Banner tone="error">{describeError(save.error).message}</Banner> : null}
                <TextField
                    label={t('common.name', 'Name')}
                    value={draft.title}
                    onChangeText={(text) => setDraft((d) => ({ ...d, title: text }))}
                    autoCapitalize="sentences"
                    testID="settings-title"
                />
                <TextField
                    label={t('common.description', 'Description')}
                    value={draft.description}
                    onChangeText={(text) => setDraft((d) => ({ ...d, description: text }))}
                    multiline
                    maxLines={6}
                    testID="settings-description"
                />
                <View style={styles.actions}>
                    <Text variant="caption" tone="tertiary" style={styles.count}>
                        {t('routines.canvas.result.chars', '{n} characters', { n: draft.description.length })}
                    </Text>
                    <Button size="sm" variant="ghost" label={t('mobile.flow.settings.reset', 'Reset')} disabled={!dirty || save.isPending} onPress={() => setDraft({ title, description })} />
                    <Button
                        size="sm"
                        label={t('common.save', 'Save')}
                        disabled={!dirty || !name}
                        loading={save.isPending}
                        onPress={() => save.mutate({ title: name, description: draft.description.trim() || null })}
                        testID="settings-save"
                    />
                </View>
            </View>
        </Group>
    );
}
