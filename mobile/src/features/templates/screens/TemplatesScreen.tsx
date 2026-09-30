/**
 * Templates.
 *
 * A template is a Word document with `{{placeholders}}` in it. The server
 * extracts them on upload (mammoth → extractParameters in routes/templates.js)
 * and the chat runtime's whole job is to fill them in from what you tell it,
 * from an attached file, or from the knowledge base the upload auto-created.
 *
 * The entire router is behind requireBetaFeature('templates'), so a 403 on the
 * list is the expected answer for most organisations. That is an explanation,
 * not an error — a red banner with a Retry button that can never succeed would
 * be actively misleading.
 */

import { Stack } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { EmptyState, Icon, IconButton, Screen, ScreenHeader, SearchField } from '@/shared/ui';

import { DeleteTemplateSheet } from '../components/DeleteTemplateSheet';
import { TemplateChatModal } from '../components/TemplateChatModal';
import { TemplateDetailSheet } from '../components/TemplateDetailSheet';
import { TemplateList } from '../components/TemplateList';
import { useTemplateUploads } from '../hooks/mutations';
import { useTemplates } from '../hooks/queries';
import { isUnavailable } from '../model/availability';
import type { Template } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ search: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm } });

export function TemplatesScreen() {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const [search, setSearch] = useState('');
    const [detailOf, setDetailOf] = useState<Template | null>(null);
    const [chatWith, setChatWith] = useState<Template | null>(null);
    const [pendingDelete, setPendingDelete] = useState<Template | null>(null);

    const query = useTemplates();
    const { uploads, pick } = useTemplateUploads();
    const unavailable = query.isError && isUnavailable(query.error);

    return (
        <Screen edges={['top', 'bottom']}>
            <Stack.Screen options={{ headerShown: false }} />

            <ScreenHeader
                title="Templates"
                actions={
                    unavailable ? null : (
                        <IconButton
                            icon={<Icon name="Upload" size={20} color={theme.colors.textPrimary} />}
                            accessibilityLabel="Upload a Word template"
                            onPress={() => void pick()}
                        />
                    )
                }
            />

            {unavailable ? (
                <EmptyState
                    icon="Lock"
                    title="Templates are not enabled"
                    message="Templates are a beta feature on this server. An administrator can switch them on for your organisation."
                />
            ) : (
                <>
                    <View style={styles.search}>
                        <SearchField value={search} onChangeText={setSearch} placeholder="Search templates" />
                    </View>
                    <TemplateList
                        query={query}
                        search={search}
                        uploads={uploads}
                        onOpen={setDetailOf}
                        onDelete={setPendingDelete}
                        onUpload={() => void pick()}
                    />
                </>
            )}

            <TemplateDetailSheet
                template={detailOf}
                onClose={() => setDetailOf(null)}
                onChat={(template) => {
                    setDetailOf(null);
                    setChatWith(template);
                }}
                onDelete={setPendingDelete}
            />
            <TemplateChatModal template={chatWith} onClose={() => setChatWith(null)} />
            <DeleteTemplateSheet
                template={pendingDelete}
                onCancel={() => setPendingDelete(null)}
                onDeleted={() => {
                    setPendingDelete(null);
                    setDetailOf(null);
                }}
            />
        </Screen>
    );
}
