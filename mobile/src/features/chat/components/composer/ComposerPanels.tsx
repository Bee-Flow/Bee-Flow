/** The composer's sheets: ＋ (context and tools), media, and apps — one open at a time. */

import React from 'react';

import type { MediaKind } from '@/features/chat/model/mediaCatalog';
import type { ChatContext } from '@/features/chat/model/types';

import { AppsSheet } from './AppsSheet';
import { ContextSheet } from './ContextSheet';
import { MediaSheet } from './MediaSheet';

export type ComposerPanel = 'context' | 'media' | 'apps' | null;

export interface ComposerPanelsProps {
    open: ComposerPanel;
    onOpen: (panel: ComposerPanel) => void;
    context: ChatContext;
    onChange: (next: ChatContext) => void;
    sources: boolean;
    picker: { pickDocument: () => void; pickImage: () => void; takePhoto: () => void };
    mediaGates?: Readonly<Record<MediaKind, boolean>>;
    apps?: boolean;
    onVoice?: () => void;
}

export function ComposerPanels({ open, onOpen, context, onChange, sources, picker, mediaGates, apps, onVoice }: ComposerPanelsProps) {
    const close = () => onOpen(null);
    const canMedia = Boolean(mediaGates && Object.values(mediaGates).some(Boolean));
    return (
        <>
            <ContextSheet
                visible={open === 'context'}
                onClose={close}
                context={context}
                onChange={onChange}
                sources={sources}
                onDocument={picker.pickDocument}
                onImage={picker.pickImage}
                onCamera={picker.takePhoto}
                tools={{
                    onMedia: canMedia ? () => onOpen('media') : undefined,
                    onApps: apps ? () => onOpen('apps') : undefined,
                    onVoice,
                }}
            />
            {mediaGates && canMedia ? <MediaSheet visible={open === 'media'} onClose={close} gates={mediaGates} /> : null}
            {apps ? <AppsSheet visible={open === 'apps'} onClose={close} /> : null}
        </>
    );
}
