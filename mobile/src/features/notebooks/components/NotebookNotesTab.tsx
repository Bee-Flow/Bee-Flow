/**
 * The notes half of a notebook: the document the web shows beside its
 * sources, edited here as Markdown (model/noteText.ts says why that
 * round-trips). Write and Preview are switched, not split — a phone has room
 * for one — and the save state sits above both, so "Saved" is always in view.
 */

import React, { useRef, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Markdown } from '@/shared/markdown';
import { Banner, ListSkeleton, Segmented, Text } from '@/shared/ui';

import { NoteSaveState } from './NoteSaveState';
import { NoteToolbar } from './NoteToolbar';
import type { NoteDraft } from '../hooks/useNoteDraft';
import { applyFormat, type MarkdownFormat, type Selection } from '../model/markdownEdit';

type Mode = 'write' | 'preview';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        root: { flex: 1 },
        bar: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.spacing.md,
            paddingHorizontal: theme.spacing.lg,
            paddingBottom: theme.spacing.sm,
        },
        banner: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
        input: {
            ...theme.type.body,
            flex: 1,
            color: theme.colors.textPrimary,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
            textAlignVertical: 'top',
        },
        preview: { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md, paddingBottom: 96 },
    });

function NotesBanner({ draft }: { draft: NoteDraft }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    if (draft.editable && !draft.fromRichEditor) return null;
    return (
        <View style={styles.banner}>
            <Banner tone={draft.editable ? 'info' : 'warning'} icon={draft.editable ? 'Info' : 'Lock'}>
                {draft.editable
                    ? t(
                          'mobile.notebooks.rich_doc_hint',
                          'These notes were written in the web editor. Saving here stores them as Markdown, so colours, charts and column widths are dropped.',
                      )
                    : t(
                          'mobile.notebooks.notes_read_only',
                          'This document could not be converted for editing on the phone. Open it in the browser to change it.',
                      )}
            </Banner>
        </View>
    );
}

function NoteEditor({ draft }: { draft: NoteDraft }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const selection = useRef<Selection>({ start: draft.text.length, end: draft.text.length });
    // Set only right after a toolbar edit, so the cursor lands where the edit
    // put it; handed back to the keyboard on the next selection change.
    const [placed, setPlaced] = useState<Selection | undefined>(undefined);

    const format = (kind: MarkdownFormat) => {
        const edit = applyFormat(draft.text, selection.current, kind);
        selection.current = edit.selection;
        setPlaced(edit.selection);
        draft.edit(edit.text);
    };

    return (
        <>
            <TextInput
                value={draft.text}
                onChangeText={draft.edit}
                onSelectionChange={(e) => {
                    selection.current = e.nativeEvent.selection;
                    if (placed) setPlaced(undefined);
                }}
                selection={placed}
                multiline
                scrollEnabled
                autoCapitalize="sentences"
                placeholder={t('mobile.notebooks.notes_placeholder', 'Write your notes. Markdown works: # for a heading, **bold**, - for a list.')}
                placeholderTextColor={theme.colors.textMuted}
                accessibilityLabel={t('notebooks.notes', 'Notes')}
                style={styles.input}
            />
            <NoteToolbar onFormat={format} />
        </>
    );
}

function NotePreview({ text }: { text: string }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <ScrollView contentContainerStyle={styles.preview}>
            {text.trim() ? (
                <Markdown value={text} />
            ) : (
                <Text variant="body" tone="tertiary">
                    {t('notebooks.no_content_preview', 'No content preview available.')}
                </Text>
            )}
        </ScrollView>
    );
}

export function NotebookNotesTab({ draft }: { draft: NoteDraft }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [mode, setMode] = useState<Mode>(draft.text.trim() ? 'preview' : 'write');

    if (!draft.loaded) return <ListSkeleton rows={4} />;
    const writing = draft.editable && mode === 'write';
    return (
        <View style={styles.root}>
            <View style={styles.bar}>
                {draft.editable ? (
                    <Segmented<Mode>
                        value={mode}
                        onChange={setMode}
                        options={[
                            { value: 'write', label: t('mobile.notebooks.write', 'Write') },
                            { value: 'preview', label: t('notebooks.preview', 'Preview') },
                        ]}
                    />
                ) : (
                    <View />
                )}
                <NoteSaveState status={draft.status} error={draft.error} onRetry={draft.retry} />
            </View>
            <NotesBanner draft={draft} />
            {writing ? <NoteEditor draft={draft} /> : <NotePreview text={draft.text} />}
        </View>
    );
}
