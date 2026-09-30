/**
 * The sources in "How I got this answer": one card per DOCUMENT, not one per
 * passage (BFSF-352), with the passages of a document a tap away; and the
 * line above the sheet counts the same documents.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { TranscriptActionsContext } from '@/features/chat/hooks/transcriptActions';
import type { ChatMessage, KbSource } from '@/features/chat/model/types';
import { renderScreen, renderWithProviders } from '@/shared/testing/renderWithProviders';

import { AnswerTrace } from './AnswerTrace';
import { TraceSources } from './TraceSources';

const SOURCES: KbSource[] = [
    { title: 'Standup', documentId: 'd1', section: 'Decisions', page: 2, snippet: 'We ship on Friday.', openable: true, chunkId: 'c1' },
    { title: 'Handbook', documentId: 'd2', page: 12, snippet: 'One month notice.', openable: true, chunkId: 'c2' },
    { title: 'Standup', documentId: 'd1', snippet: 'Tessa owns the release.', openable: true, chunkId: 'c3' },
    { title: 'Standup', documentId: 'd1', section: 'Actions', snippet: 'Write the notes.', openable: true, chunkId: 'c4' },
    { snippet: 'A passage without a title.', openable: true, chunkId: 'c5' },
];

describe('TraceSources', () => {
    it('lists each document once, under how many passages came from how many documents', async () => {
        await renderWithProviders(<TraceSources sources={SOURCES} />);
        expect(screen.getByText('5 SOURCES FROM 3 DOCUMENTS')).toBeTruthy();
        expect(screen.getAllByText('Standup')).toHaveLength(1);
        expect(screen.getByText('3 passages from this document')).toBeTruthy();
        expect(screen.getByText('Handbook · p. 12')).toBeTruthy();
        expect(screen.getByText('Unknown Source')).toBeTruthy();
        // A document of one passage shows it; a document of several keeps them folded.
        expect(screen.getByText('One month notice.')).toBeTruthy();
        expect(screen.queryByText('We ship on Friday.')).toBeNull();
        expect(screen.getAllByRole('button')).toHaveLength(3);
    });

    it('opens a document to each passage, with its heading and page, and folds it again', async () => {
        await renderWithProviders(<TraceSources sources={SOURCES} />);
        await fireEvent.press(screen.getByText('Standup'));
        expect(screen.getByText('Decisions · p. 2')).toBeTruthy();
        expect(screen.getByText('We ship on Friday.')).toBeTruthy();
        expect(screen.getByText('Chunk 2')).toBeTruthy();
        expect(screen.getByText('Tessa owns the release.')).toBeTruthy();
        expect(screen.getByText('Actions')).toBeTruthy();
        expect(screen.getByText('Write the notes.')).toBeTruthy();

        await fireEvent.press(screen.getByText('Standup'));
        expect(screen.queryByText('We ship on Friday.')).toBeNull();
    });
});

describe('the line above it', () => {
    const MESSAGE: ChatMessage = { id: 'a', role: 'assistant', content: 'The release is on Friday.', sources: SOURCES };

    it('counts documents, and its sheet lists the same documents', async () => {
        await renderScreen(
            <TranscriptActionsContext.Provider value={{ showSources: true }}>
                <AnswerTrace message={MESSAGE} />
            </TranscriptActionsContext.Provider>,
        );
        expect(screen.getByText('3 documents')).toBeTruthy();
        expect(screen.queryByText('5 sources')).toBeNull();
        await fireEvent.press(screen.getByText('How I got this answer'));
        expect(screen.getByText('5 SOURCES FROM 3 DOCUMENTS')).toBeTruthy();
    });

    it('shows neither where sources may not be shown', async () => {
        await renderScreen(
            <TranscriptActionsContext.Provider value={{ showSources: false }}>
                <AnswerTrace message={{ ...MESSAGE, tools: [{ id: 't', name: 'kb_search', status: 'done', startTime: 0, endTime: 500 }] }} />
            </TranscriptActionsContext.Provider>,
        );
        expect(screen.queryByText('3 documents')).toBeNull();
        await fireEvent.press(screen.getByText('How I got this answer'));
        expect(screen.queryByText('5 SOURCES FROM 3 DOCUMENTS')).toBeNull();
        expect(screen.queryByText('Standup')).toBeNull();
    });
});
