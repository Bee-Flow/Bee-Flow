/**
 * House styles — the org's Word templates that notebook exports are dressed in.
 *
 * Read-only for most people, and that is correct rather than a limitation:
 * routes/houseStyles.js lets any org member list them but requires org admin
 * to upload, rename or change the default. So the phone shows what is in force
 * and lets an admin switch the default (a one-tap decision that is genuinely
 * useful away from a desk); uploading a .docx is left to the web app, where
 * the file already is.
 *
 * A member who taps "Make default" gets the server's own 403 as an inline
 * explanation, not a toast that vanishes.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { View } from 'react-native';

import { relativeTime } from '../../../lib/time';
import { useTheme } from '../../../theme/ThemeProvider';
import { Badge } from '../../../ui/Badge';
import { Banner, EmptyState, ErrorState, ListSkeleton, describeError } from '../../../ui/Feedback';
import { ListRow } from '../../../ui/List';
import { Sheet } from '../../../ui/Sheet';
import { Text } from '../../../ui/Text';
import { useToast } from '../../../ui/Toast';
import { libraryKeys, listHouseStyles, setDefaultHouseStyle } from '../api';

export function HouseStylesSheet({
    visible,
    onClose,
    orgId,
}: {
    visible: boolean;
    onClose: () => void;
    /** Null when the account is not in an organisation — there is nothing to show. */
    orgId: string | null;
}) {
    const theme = useTheme();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const [denied, setDenied] = useState<string | null>(null);

    const query = useQuery({
        queryKey: libraryKeys.houseStyles(orgId ?? ''),
        queryFn: ({ signal }) => listHouseStyles(orgId as string, signal),
        enabled: visible && Boolean(orgId),
    });

    const makeDefault = useMutation({
        mutationFn: (id: string) => setDefaultHouseStyle(orgId as string, id),
        onSuccess: () => {
            setDenied(null);
            toast('Default house style changed', 'success');
            void queryClient.invalidateQueries({ queryKey: libraryKeys.houseStyles(orgId ?? '') });
        },
        onError: (err) => {
            // 403 here means "org admin required" and is the expected answer for
            // most people, so it explains itself in place rather than as a error
            // banner that implies something broke.
            setDenied(describeError(err).message);
        },
    });

    const styles = query.data ?? [];

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title="House styles"
            subtitle="Applied when a notebook is exported to Word"
            scroll={false}
            tall
        >
            <View style={{ flexShrink: 1 }}>
                {denied ? (
                    <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md }}>
                        <Banner tone="info">{denied}</Banner>
                    </View>
                ) : null}

                {!orgId ? (
                    <EmptyState
                        icon="briefcase"
                        title="No organisation"
                        message="House styles belong to an organisation, and this account is not in one."
                    />
                ) : query.isLoading ? (
                    <ListSkeleton rows={3} />
                ) : query.isError ? (
                    <ErrorState error={query.error} onRetry={() => void query.refetch()} />
                ) : styles.length === 0 ? (
                    <EmptyState
                        icon="type"
                        title="No house styles yet"
                        message="An administrator uploads a .docx in the web app and every export from then on follows it."
                    />
                ) : (
                    <View>
                        {styles.map((style) => (
                            <ListRow
                                key={style.id}
                                title={style.name}
                                subtitle={style.description || `Added ${relativeTime(style.createdAt)}`}
                                wrapTitle
                                leading={
                                    <Feather
                                        name="type"
                                        size={20}
                                        color={
                                            style.isDefault
                                                ? theme.colors.accentPrimary
                                                : theme.colors.textMuted
                                        }
                                    />
                                }
                                trailing={
                                    style.isDefault ? (
                                        <Badge label="Default" tone="accent" />
                                    ) : (
                                        <Text variant="label" tone="accent">
                                            Make default
                                        </Text>
                                    )
                                }
                                onPress={
                                    style.isDefault ? undefined : () => makeDefault.mutate(style.id)
                                }
                                disabled={makeDefault.isPending}
                            />
                        ))}
                    </View>
                )}
            </View>
        </Sheet>
    );
}
