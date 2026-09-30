/**
 * The AI chat behind Preview's "AI Chat" switch: how the builder edits, New
 * chat, and the transcript — the web editor's chat panel. The transcript and
 * its cells are the chat feature's own, so answers read as in every chat.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { ChatTranscript } from '@/features/chat';

import { BuildModeBar } from './BuildModeBar';
import { BuildStarters } from './BuildStarters';
import type { Builder } from '../hooks/useBuilder';

const styles = StyleSheet.create({ fill: { flex: 1 } });

export function BuilderChat({ builder }: { builder: Builder }) {
    const { chat, messages } = builder;
    return (
        <View style={styles.fill}>
            <BuildModeBar
                mode={builder.mode}
                onMode={builder.setMode}
                canStartOver={messages.length > 0 && !chat.streaming}
                onStartOver={() => void chat.startOver()}
            />
            {messages.length === 0 ? (
                <BuildStarters disabled={chat.streaming} onPick={(brief) => chat.send(brief)} />
            ) : (
                <ChatTranscript messages={messages} store={chat.store} />
            )}
        </View>
    );
}
