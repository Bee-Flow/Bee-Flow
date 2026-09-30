/**
 * Preview, the page screen's main view: the rendered page, full width, and —
 * for its owner — "Edit with AI" under it. Ask for a change, and the preview
 * refreshes when the builder's turn lands. A page with nothing built yet
 * shows the web's example briefs in its place, so New webpage → describe it →
 * watch it appear is one screen.
 *
 * A colleague the page was published to gets the page and nothing to edit.
 */

import { useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { LoadingState } from '@/shared/ui';

import { BuildDock } from './BuildDock';
import { BuilderChat } from './BuilderChat';
import { BuildStarters } from './BuildStarters';
import { PreviewPane } from './PreviewPane';
import { PreviewToolbar, type PreviewView } from './PreviewToolbar';
import { webpageKeys } from '../api/keys';
import { useBuilder, type Builder } from '../hooks/useBuilder';
import { isUnbuilt, type PreviewDevice } from '../model/preview';
import type { WebpageDetail } from '../model/types';

const styles = StyleSheet.create({ fill: { flex: 1 } });

interface PreviewProps {
    pageId: string;
    detail: WebpageDetail;
}

function usePreviewControls(pageId: string) {
    const queryClient = useQueryClient();
    const [device, setDevice] = useState<PreviewDevice>('mobile');
    const [reloadKey, setReloadKey] = useState(0);
    const reload = () => {
        setReloadKey((k) => k + 1);
        void queryClient.invalidateQueries({ queryKey: webpageKeys.document(pageId) });
    };
    return { device, setDevice, reloadKey, reload };
}

function PageArea({ pageId, detail, builder, controls }: PreviewProps & { builder: Builder; controls: ReturnType<typeof usePreviewControls> }) {
    const t = useTranslation();
    const { chat, messages } = builder;
    if (isUnbuilt(detail.webpage, detail.extraFiles.length)) {
        if (chat.streaming) return <LoadingState label={t('mobile.webpages.preview.first_build', 'Building your page…')} />;
        if (messages.length === 0) return <BuildStarters disabled={chat.streaming} onPick={(brief) => chat.send(brief)} />;
    }
    return (
        <PreviewPane
            pageId={pageId}
            detail={detail}
            device={controls.device}
            reloadKey={controls.reloadKey}
            onReload={controls.reload}
        />
    );
}

function OwnerPreview({ pageId, detail }: PreviewProps) {
    const [view, setView] = useState<PreviewView>('page');
    const controls = usePreviewControls(pageId);
    const builder = useBuilder(pageId, detail.chatMessages);

    return (
        <View style={styles.fill}>
            <PreviewToolbar
                view={view}
                onView={setView}
                device={controls.device}
                onDevice={controls.setDevice}
                onReload={controls.reload}
            />
            <View style={styles.fill}>
                {view === 'chat' ? (
                    <BuilderChat builder={builder} />
                ) : (
                    <PageArea pageId={pageId} detail={detail} builder={builder} controls={controls} />
                )}
            </View>
            <BuildDock builder={builder} showActivity={view === 'page'} />
        </View>
    );
}

function ViewerPreview({ pageId, detail }: PreviewProps) {
    const controls = usePreviewControls(pageId);
    return (
        <View style={styles.fill}>
            <PreviewToolbar view="page" device={controls.device} onDevice={controls.setDevice} onReload={controls.reload} />
            <PreviewPane
                pageId={pageId}
                detail={detail}
                device={controls.device}
                reloadKey={controls.reloadKey}
                onReload={controls.reload}
            />
        </View>
    );
}

export function PreviewTab({ pageId, detail }: PreviewProps) {
    return detail.readOnly ? <ViewerPreview pageId={pageId} detail={detail} /> : <OwnerPreview pageId={pageId} detail={detail} />;
}
