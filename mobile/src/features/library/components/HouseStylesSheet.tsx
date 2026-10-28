/**
 * House styles — the org's Word templates that notebook exports are dressed in.
 *
 * Read-only for most people, and that is correct rather than a limitation:
 * routes/houseStyles.js lets any org member list them but requires org admin
 * to upload, rename or change the default. So the phone shows what is in force
 * and lets an admin switch the default; uploading a .docx is left to the web
 * app, where the file already is.
 *
 * A member who taps "Make default" gets the server's own 403 as an inline
 * explanation, not a toast that vanishes.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, EmptyState, ErrorState, ListSkeleton, Sheet, useToast } from '@/shared/ui';

import { HouseStyleRow } from './HouseStyleRow';
import { useHouseStyles, useMakeDefaultHouseStyle } from '../hooks/houseStyles';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { flexShrink: 1 },
        denied: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md },
    });

/** An org's handful of house styles, or why there are none to show. */
function HouseStylesBody({ orgId, visible, onDenied }: { orgId: string | null; visible: boolean; onDenied: (message: string | null) => void }) {
    const t = useTranslation();
    const { toast } = useToast();
    const query = useHouseStyles(orgId, visible);
    const makeDefault = useMakeDefaultHouseStyle(orgId, {
        onSuccess: () => {
            onDenied(null);
            toast(t('mobile.library.default_changed', 'Default house style changed'), 'success');
        },
        // 403 here means "org admin required" and is the expected answer for
        // most people, so it explains itself in place.
        onError: (err) => onDenied(describeError(err).message),
    });
    const styles = query.data ?? [];

    if (!orgId) {
        return (
            <EmptyState
                icon="Briefcase"
                title={t('mobile.library.no_org', 'No organisation')}
                message={t('mobile.library.no_org_hint', 'House styles belong to an organisation, and this account is not in one.')}
            />
        );
    }
    if (query.isLoading) return <ListSkeleton rows={3} />;
    if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
    if (styles.length === 0) {
        return (
            <EmptyState
                icon="Type"
                title={t('mobile.library.no_styles', 'No house styles yet')}
                message={t('mobile.library.no_styles_hint', 'An administrator uploads a .docx in the web app and every export from then on follows it.')}
            />
        );
    }
    return (
        <View>
            {styles.map((style) => (
                <HouseStyleRow
                    key={style.id}
                    style={style}
                    busy={makeDefault.isPending}
                    onMakeDefault={() => makeDefault.mutate(style.id)}
                />
            ))}
        </View>
    );
}

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
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [denied, setDenied] = useState<string | null>(null);

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={t('mobile.library.house_styles', 'House styles')}
            subtitle={t('mobile.library.house_styles_sheet_hint', 'Applied when a notebook is exported to Word')}
            scroll={false}
            tall
        >
            <View style={styles.body}>
                {denied ? (
                    <View style={styles.denied}>
                        <Banner tone="info">{denied}</Banner>
                    </View>
                ) : null}
                <HouseStylesBody orgId={orgId} visible={visible} onDenied={setDenied} />
            </View>
        </Sheet>
    );
}
