/**
 * Markdown in one line: the marks a sentence can hold survive, the blocks
 * flatten, and plain text comes out as plain text.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { InlineMarkdown } from './InlineMarkdown';

jest.mock('expo-router', () => ({
    useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), dismissTo: jest.fn(), canDismiss: () => false }),
}));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'dismiss' })) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(), ImpactFeedbackStyle: { Light: 'light' } }));

const draw = (value: string, lines?: number) =>
    renderWithProviders(
        <ToastProvider>
            <InlineMarkdown value={value} numberOfLines={lines} testID="line" />
        </ToastProvider>,
    );

/** Every string under a node, in order: what a reader of the line sees. */
function wordsOf(node: unknown): string {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(wordsOf).join('');
    return wordsOf((node as { props?: { children?: unknown } }).props?.children);
}

describe('InlineMarkdown', () => {
    it('keeps bold and code inside the one line, without the asterisks', async () => {
        await draw('**Trigger:** When gmail emits `mail.new`', 2);
        const line = screen.getByTestId('line');
        expect(line.props.numberOfLines).toBe(2);
        expect(wordsOf(line.props.children)).toBe('Trigger: When gmail emits  mail.new ');
        expect(screen.getByText('Trigger:')).toBeTruthy();
    });

    it('flattens a heading, a list and a table into lines', async () => {
        await draw('# Digest\n\n- one\n- **two**\n\n| a | b |\n|---|---|\n| 1 | 2 |');
        expect(wordsOf(screen.getByTestId('line').props.children)).toBe('Digest\n• one\n• two\na · b\n1 · 2');
    });

    it('renders plain text as it is', async () => {
        await draw('Nothing marked up here.');
        expect(wordsOf(screen.getByTestId('line').props.children)).toBe('Nothing marked up here.');
    });

    it('opens a link', async () => {
        await draw('See [the docs](https://example.com/docs)');
        await fireEvent.press(screen.getByText('the docs'));
        await waitFor(() =>
            expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://example.com/docs', expect.anything()),
        );
    });
});
