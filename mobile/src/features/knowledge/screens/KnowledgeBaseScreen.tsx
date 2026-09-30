/**
 * One knowledge base — the web's KnowledgeDetail: ObjectHeader + TabBar over
 * Sources, Documents, Test question, Settings and Used by.
 *
 * Material gets in two ways: SOURCES that keep themselves up to date (a web
 * page or site on a schedule, a sitemap, an n8n workflow), and the phone's
 * own upload / scan / link / paste sheet. "Add a source" offers both. A
 * system base is kept up to date for Bee Flow and is read-only here.
 */

import { Stack, useRouter } from 'expo-router';
import React, { useState } from 'react';

import { useHasPermission } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { UsedByList, useUserRefresh } from '@/shared/patterns';
import { Screen } from '@/shared/ui';

import { AskTab } from '../components/AskTab';
import { DocumentsTab } from '../components/DocumentsTab';
import { IngestSheets } from '../components/IngestSheets';
import { KbAddMenu, type AddChoice } from '../components/KbAddMenu';
import { KbDeleteSheets } from '../components/KbDeleteSheets';
import { KbHeader, kbTabFrom, type KbTab } from '../components/KbHeader';
import { KbSettingsTab } from '../components/KbSettingsTab';
import { SitemapSheet } from '../components/SitemapSheet';
import { SourcesTab } from '../components/SourcesTab';
import { WebSourceSheet } from '../components/WebSourceSheet';
import { WorkflowSourceSheet } from '../components/WorkflowSourceSheet';
import { useKbFavorites, useKbUsage, useToggleKbFavorite } from '../hooks/manage';
import { useKbDocuments, useKnowledgeBase } from '../hooks/queries';
import { useKbSources } from '../hooks/sources';
import { useKbIngestFlow, type IngestFlow } from '../hooks/useIngestFlow';
import type { KnowledgeBase } from '../model/types';

type Sheet = AddChoice | 'menu' | 'delete' | null;

interface TabBodyProps {
    tab: KbTab;
    kbId: string;
    kb: KnowledgeBase | null | undefined;
    canManage: boolean;
    flow: IngestFlow;
    usage: ReturnType<typeof useKbUsage>;
    refreshing: boolean;
    onRefresh: () => void;
    onAdd: () => void;
    onDelete: () => void;
}

/** The open section's body. */
function TabBody({ tab, kbId, kb, canManage, flow, usage, refreshing, onRefresh, onAdd, onDelete }: TabBodyProps) {
    const t = useTranslation();
    switch (tab) {
        case 'sources':
            return <SourcesTab kbId={kbId} canManage={canManage} onAdd={onAdd} />;
        case 'documents':
            return (
                <DocumentsTab kbId={kbId} systemManaged={kb?.source_kind === 'system_managed'} canManage={canManage} uploads={flow.uploads}
                    onAdd={() => flow.setAddOpen(true)} />
            );
        case 'ask':
            return <AskTab kbId={kbId} />;
        case 'settings':
            return kb ? <KbSettingsTab kb={kb} canManage={canManage} onDelete={onDelete} refreshing={refreshing} onRefresh={onRefresh} /> : null;
        default:
            return (
                <UsedByList answer={usage.data} isLoading={usage.isLoading} error={usage.error} onRetry={() => void usage.refetch()}
                    emptyText={t('knowledge.usage_empty', 'No agent, skill or automation uses this knowledge base yet.')} />
            );
    }
}

/** `initialTab` is a link's `?tab=` (sources, documents, ask, settings, usage). */
export function KnowledgeBaseScreen({ kbId, initialTab }: { kbId: string; initialTab?: string }) {
    const t = useTranslation();
    const router = useRouter();
    const [tab, setTab] = useState<KbTab>(() => kbTabFrom(initialTab));
    const [sheet, setSheet] = useState<Sheet>(null);
    const base = useKnowledgeBase(kbId);
    const refresh = useUserRefresh(() => base.refetch());
    const kb = base.data;
    const documents = useKbDocuments(kbId);
    const sources = useKbSources(kbId);
    const usage = useKbUsage(kbId);
    const favorites = useKbFavorites();
    const toggleFavorite = useToggleKbFavorite();
    const flow = useKbIngestFlow(kbId);
    const canManage = useHasPermission('manage_knowledge') && kb?.source_kind !== 'system_managed';
    const favorite = favorites.data?.has(kbId) ?? false;
    const close = () => setSheet(null);
    const choose = (choice: AddChoice) => {
        if (choice === 'files') {
            close();
            flow.setAddOpen(true);
        } else setSheet(choice);
    };

    return (
        <Screen edges={['top', 'bottom']}>
            <Stack.Screen options={{ headerShown: false }} />
            <KbHeader
                kb={kb}
                tab={tab}
                onTab={setTab}
                counts={{ sources: sources.data?.totals.sourceCount, documents: documents.data?.total, usage: usage.data?.usage.length }}
                favorite={favorite}
                canManage={canManage}
                onAdd={() => setSheet('menu')}
                onChat={() => router.push(`/chat/new?kb=${encodeURIComponent(kbId)}`)}
                onFavorite={() => toggleFavorite.mutate({ id: kbId, favorite: !favorite })}
                onShare={() => setTab('settings')}
                onDelete={() => setSheet('delete')}
            />
            <TabBody tab={tab} kbId={kbId} kb={kb} canManage={canManage} flow={flow} usage={usage}
                refreshing={refresh.refreshing} onRefresh={refresh.onRefresh} onAdd={() => setSheet('menu')} onDelete={() => setSheet('delete')} />

            <KbAddMenu visible={sheet === 'menu'} onClose={close} onChoose={choose} />
            <WebSourceSheet key={`web:${sheet === 'web'}`} kbId={kbId} visible={sheet === 'web'} onClose={close} />
            <SitemapSheet key={`map:${sheet === 'sitemap'}`} kbId={kbId} visible={sheet === 'sitemap'} onClose={close} />
            <WorkflowSourceSheet key={`n8n:${sheet === 'workflow'}`} kbId={kbId} visible={sheet === 'workflow'} onClose={close} />
            <IngestSheets
                flow={flow}
                title={t('mobile.knowledge.add_document', 'Add a document')}
                subtitle={kb?.name}
                accepts={t('mobile.knowledge.accepts', 'PDF, Word, Excel, CSV or text · up to 20 MB')}
                scanName={kb?.name ? t('mobile.knowledge.scan_name', '{name} scan', { name: kb.name }) : undefined}
            />
            <KbDeleteSheets kb={sheet === 'delete' && kb ? kb : null} onDone={close} onDeleted={() => router.back()} />
        </Screen>
    );
}
