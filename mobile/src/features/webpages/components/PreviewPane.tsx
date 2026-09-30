/**
 * The page area of Preview: the rendered page, or why there is none.
 *
 * Every light-runtime page shows its draft as the server built it. What the
 * web paints inside the frame when there is no page to run — a React page
 * with no entry yet, React source in a plain-HTML page, a failed build — is
 * said here natively, in the web's words. A page on the full runtime shows
 * its public version while it is public, with a line saying so: that is the
 * published snapshot, not the draft the builder just changed.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { EmptyState, ErrorState, LoadingState, Text, type IconName } from '@/shared/ui';

import { PagePreview } from './PagePreview';
import { usePreviewDocument } from '../hooks/usePreviewDocument';
import type { PreviewDevice } from '../model/preview';
import type { WebpageDetail } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        fill: { flex: 1 },
        note: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xs },
        empty: { flex: 1, justifyContent: 'center', padding: theme.spacing.lg },
        buildError: { paddingTop: theme.spacing.sm },
    });

export interface PreviewPaneProps {
    pageId: string;
    detail: WebpageDetail;
    device: PreviewDevice;
    reloadKey: number;
    onReload: () => void;
}

function Notice({ icon, title, message, children }: { icon: IconName; title: string; message: string; children?: React.ReactNode }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.empty}>
            <EmptyState icon={icon} title={title} message={message} />
            {children}
        </View>
    );
}

function Unavailable() {
    const t = useTranslation();
    return (
        <Notice
            icon="Globe"
            title={t('mobile.webpages.preview.unavailable_title', 'No preview on the phone yet')}
            message={t(
                'mobile.webpages.preview.unavailable_full',
                'This page runs on its own server container, which the phone cannot show yet. Make it public to see its public version here.',
            )}
        />
    );
}

function NotBuilt({ stranded }: { stranded: boolean }) {
    const t = useTranslation();
    if (stranded) {
        return (
            <Notice
                icon="Code"
                title={t('mobile.webpages.preview.stranded_title', 'This looks like a React project')}
                message={t(
                    'mobile.webpages.preview.stranded_body',
                    'It has React source files but the page is in plain-HTML mode, so nothing renders. Ask the assistant to switch it to React + Material UI.',
                )}
            />
        );
    }
    return (
        <Notice
            icon="LayoutTemplate"
            title={t('mobile.webpages.preview.empty_title', 'Your webpage will appear here')}
            message={t('mobile.webpages.preview.empty_body', 'Ask the assistant to finish setting up your page.')}
        />
    );
}

function BuildFailed({ message }: { message: string }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <Notice
            icon="TriangleAlert"
            title={t('mobile.webpages.preview.build_error_title', 'Build error')}
            message={t('mobile.webpages.preview.build_error_body', 'The page could not be built. Ask the assistant to fix it.')}
        >
            {message ? (
                <Text variant="code" tone="tertiary" selectable style={styles.buildError}>
                    {message}
                </Text>
            ) : null}
        </Notice>
    );
}

export function PreviewPane({ pageId, detail, device, reloadKey, onReload }: PreviewPaneProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const doc = usePreviewDocument(pageId, detail, device);

    if (doc.status === 'loading') return <LoadingState />;
    if (doc.status === 'error') return <ErrorState error={doc.error} onRetry={doc.retry} />;
    if (doc.status === 'unavailable') return <Unavailable />;
    if (doc.status === 'empty' || doc.status === 'stranded') return <NotBuilt stranded={doc.status === 'stranded'} />;
    if (doc.status === 'build_error') return <BuildFailed message={doc.message} />;
    return (
        <View style={styles.fill}>
            {doc.published ? (
                <Text variant="caption" tone="tertiary" style={styles.note}>
                    {t(
                        'mobile.webpages.preview.published_note',
                        'Showing the public version. Changes appear here once they are published.',
                    )}
                </Text>
            ) : null}
            <PagePreview html={doc.html} baseUrl={doc.baseUrl} reloadKey={reloadKey} onReload={onReload} />
        </View>
    );
}
