/**
 * One webpage, as a Studio object: the header (name, state, the overflow
 * menu) over its sections — Preview first (the rendered page with "Edit with
 * AI" under it), then History, Data & links, Knowledge, Share and Settings.
 *
 * `readOnly` marks a page published to you that you do not own. Every write
 * and every owner-only read is refused by the server for such a viewer, so
 * the screen offers them only Preview and Share (model/tabs.ts).
 *
 * Preview stays mounted, hidden while another section is showing: a builder
 * turn can run for minutes, and looking at the history while it works must
 * not stop it or lose the transcript.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { QueryScreen } from '@/shared/patterns';
import { ScreenHeader } from '@/shared/ui';

import { DataTab } from '../components/DataTab';
import { DeletePageSheets } from '../components/DeletePageSheets';
import { HistoryTab } from '../components/HistoryTab';
import { KnowledgeTab } from '../components/KnowledgeTab';
import { PageHeader } from '../components/PageHeader';
import { PreviewTab } from '../components/PreviewTab';
import { SettingsTab } from '../components/SettingsTab';
import { ShareTab } from '../components/ShareTab';
import { useWebpage } from '../hooks/queries';
import { initialTab, tabItems, type WebpageTab } from '../model/tabs';
import type { WebpageDetail } from '../model/types';

const styles = StyleSheet.create({
    fill: { flex: 1 },
    hidden: { display: 'none' },
});

interface TabBodyProps {
    tab: WebpageTab;
    pageId: string;
    detail: WebpageDetail;
    onDelete: () => void;
}

function TabBody({ tab, pageId, detail, onDelete }: TabBodyProps) {
    switch (tab) {
        case 'knowledge':
            return <KnowledgeTab pageId={pageId} />;
        case 'history':
            return <HistoryTab pageId={pageId} />;
        case 'data':
            return <DataTab pageId={pageId} />;
        case 'share':
            return <ShareTab pageId={pageId} detail={detail} />;
        case 'settings':
            return <SettingsTab pageId={pageId} webpage={detail.webpage} onDelete={onDelete} />;
        default:
            return null;
    }
}

function WebpageBody({ pageId, detail, requested }: { pageId: string; detail: WebpageDetail; requested?: string }) {
    const [tab, setTab] = useState<WebpageTab>(() => initialTab(requested, detail.readOnly));
    const [previewOpened, setPreviewOpened] = useState(tab === 'preview');
    const [deleting, setDeleting] = useState(false);
    const choose = (next: WebpageTab) => {
        if (next === 'preview') setPreviewOpened(true);
        setTab(next);
    };

    return (
        <View style={styles.fill}>
            <PageHeader
                webpage={detail.webpage}
                readOnly={detail.readOnly}
                tabs={tabItems(detail.readOnly, { sources: detail.webpage.sourceCount })}
                tab={tab}
                onTab={choose}
                onDelete={() => setDeleting(true)}
            />
            {previewOpened ? (
                <View style={tab === 'preview' ? styles.fill : styles.hidden}>
                    <PreviewTab pageId={pageId} detail={detail} />
                </View>
            ) : null}
            {tab === 'preview' ? null : (
                <View style={styles.fill}>
                    <TabBody tab={tab} pageId={pageId} detail={detail} onDelete={() => setDeleting(true)} />
                </View>
            )}
            <DeletePageSheets
                pageId={pageId}
                name={detail.webpage.name}
                visible={deleting}
                onClose={() => setDeleting(false)}
            />
        </View>
    );
}

export function WebpageScreen({ pageId, tab }: { pageId: string; tab?: string }) {
    const t = useTranslation();
    const page = useWebpage(pageId);

    return (
        <QueryScreen
            scroll={false}
            query={{
                data: page.data ?? undefined,
                isLoading: page.isLoading,
                isError: page.isError,
                error: page.error ?? new Error(t('mobile.webpages.gone', 'This page no longer exists.')),
                refetch: page.refetch,
            }}
            header={(detail) => (detail ? null : <ScreenHeader title={t('automations.trigger_editors.page', 'Page')} />)}
        >
            {(detail) => <WebpageBody pageId={pageId} detail={detail} requested={tab} />}
        </QueryScreen>
    );
}
