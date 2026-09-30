/**
 * One tool call's raw input and result — the web's expanded row. While the
 * turn is live the result is whole; a reloaded turn has the server's cut
 * preview, which is all it keeps.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { toolLabel, toolPayload } from '@/features/chat/model/toolDisplay';
import type { ToolActivity } from '@/features/chat/model/types';
import { Sheet, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    block: { marginBottom: theme.spacing.lg, gap: theme.spacing.xs },
    pre: {
        borderRadius: theme.radii.sm,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        backgroundColor: theme.colors.bgPrimary,
        padding: theme.spacing.sm,
    },
});

export function ToolOutputSheet({ tool, onClose }: { tool: ToolActivity | null; onClose: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const payload = tool ? toolPayload(tool) : { args: null, result: null };
    const parts = [
        { label: t('chat.act.input', 'Input'), text: payload.args },
        { label: t('chat.act.result', 'Result'), text: tool?.status === 'running' ? null : payload.result },
    ].filter((part): part is { label: string; text: string } => Boolean(part.text));

    return (
        <Sheet
            visible={tool !== null}
            onClose={onClose}
            title={t('chat.msg.tool_output_of', 'Tool Output: {name}', { name: toolLabel(tool?.name) })}
            tall
        >
            {parts.map((part) => (
                <View key={part.label} style={styles.block}>
                    <Text variant="label" tone="tertiary">
                        {part.label.toUpperCase()}
                    </Text>
                    <View style={styles.pre}>
                        <Text variant="code" selectable>
                            {part.text}
                        </Text>
                    </View>
                </View>
            ))}
            {parts.length === 0 ? (
                <Text variant="body" tone="tertiary">
                    {t('chat.msg.tool_data_ok', 'Data returned successfully. Check debug view for details.')}
                </Text>
            ) : null}
        </Sheet>
    );
}
