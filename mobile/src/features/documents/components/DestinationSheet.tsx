/**
 * "Where should this go?" Ingestion is per knowledge base, so an upload needs
 * a destination — asked for only when the answer is not already on screen.
 * The list of bases is what the caller can reach; it is short, so a map.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import type { KnowledgeBase } from '@/features/knowledge';
import { Divider, EmptyState, Icon, ListRow, Sheet } from '@/shared/ui';

export function DestinationSheet({
    visible,
    bases,
    onClose,
    onPick,
}: {
    visible: boolean;
    bases: KnowledgeBase[];
    onClose: () => void;
    onPick: (kbId: string) => void;
}) {
    const theme = useTheme();
    const router = useRouter();

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title="Add it to which knowledge base?"
            subtitle="Documents are indexed per knowledge base"
            scroll={false}
        >
            <View>
                {bases.map((kb, i) => (
                    <React.Fragment key={kb.id}>
                        {i > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                        <ListRow
                            title={kb.name}
                            subtitle={kb.description || undefined}
                            leading={<Icon name="Database" size={18} color={theme.colors.textMuted} />}
                            onPress={() => onPick(kb.id)}
                        />
                    </React.Fragment>
                ))}
                {bases.length === 0 ? (
                    <EmptyState
                        icon="Database"
                        title="No knowledge bases yet"
                        message="Documents live inside a knowledge base, so there has to be one first."
                        actionLabel="Create one"
                        onAction={() => {
                            onClose();
                            router.push('/knowledge');
                        }}
                    />
                ) : null}
            </View>
        </Sheet>
    );
}
