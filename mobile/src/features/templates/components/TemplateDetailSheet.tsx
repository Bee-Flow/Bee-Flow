/**
 * One template, opened. The primary action is "start a chat", not
 * "download": filling the placeholders in is the reason the feature exists,
 * so downloading the blank .docx is available and quiet.
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { shareServerFile } from '@/core/api/shareFile';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Divider, Icon, Sheet, Text, useToast } from '@/shared/ui';

import { TemplatePlaceholders } from './TemplatePlaceholders';
import { templateDownloadPath } from '../api/endpoints';
import type { Template } from '../model/types';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        footer: { gap: theme.spacing.sm },
        instructions: { gap: theme.spacing.xs },
        delete: { minHeight: theme.minTouch, justifyContent: 'center' },
    });

/** Share the blank .docx, with a spinner while its bytes are fetched. */
function useDownload() {
    const { toast } = useToast();
    const [downloading, setDownloading] = useState(false);
    const download = async (template: Template) => {
        setDownloading(true);
        try {
            await shareServerFile(templateDownloadPath(template.id), template.fileName || `${template.name}.docx`, DOCX_MIME);
        } catch (err) {
            toast(describeError(err).message, 'error');
        } finally {
            setDownloading(false);
        }
    };
    return { downloading, download };
}

export function TemplateDetailSheet({
    template,
    onClose,
    onChat,
    onDelete,
}: {
    template: Template | null;
    onClose: () => void;
    onChat: (template: Template) => void;
    onDelete: (template: Template) => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { downloading, download } = useDownload();

    const footer = (
        <View style={styles.footer}>
            <Button
                label="Start a chat from this"
                fullWidth
                onPress={() => template && onChat(template)}
                icon={<Icon name="MessageCircle" size={16} color={theme.colors.accentPrimaryFg} />}
            />
            <Button
                label="Download the blank template"
                variant="secondary"
                fullWidth
                loading={downloading}
                onPress={() => template && void download(template)}
            />
        </View>
    );

    return (
        <Sheet
            visible={Boolean(template)}
            onClose={onClose}
            title={template?.name ?? ''}
            subtitle={template?.fileName ?? undefined}
            footer={footer}
        >
            {template?.description ? (
                <Text variant="body" tone="secondary">
                    {template.description}
                </Text>
            ) : null}

            <TemplatePlaceholders parameters={template?.parameters ?? []} />

            {template?.instructions ? (
                <>
                    <Divider />
                    <View style={styles.instructions}>
                        <Text variant="label" tone="tertiary">
                            HOW IT SHOULD BE FILLED
                        </Text>
                        <Text variant="caption" tone="secondary">
                            {template.instructions}
                        </Text>
                    </View>
                </>
            ) : null}

            <Pressable
                onPress={() => template && onDelete(template)}
                accessibilityRole="button"
                accessibilityLabel={`Delete ${template?.name ?? 'this template'}`}
                style={styles.delete}
            >
                <Text variant="body" tone="error">
                    Delete this template
                </Text>
            </Pressable>
        </Sheet>
    );
}
