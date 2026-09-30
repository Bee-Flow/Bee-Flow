/**
 * The block and inline renderers: lists with the web's markers, task items,
 * headings and their anchors, links (app screens, the web, anchors), link
 * cards, pictures, tables, quotes, entities and raw HTML.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import React, { useRef } from 'react';
import { ScrollView } from 'react-native';

import { Markdown, MarkdownLinkProvider, MarkdownScrollHostProvider } from '@/shared/markdown';
import { renderMarkdown } from '@/shared/testing/renderMarkdown';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { bulletMarker, markerWidth, numberMarker } from './listMarkers';

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })) }));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
    useRouter: () => ({ push: mockPush, navigate: mockPush, dismissTo: mockPush, canDismiss: () => false }),
}));

beforeEach(() => jest.clearAllMocks());

describe('list markers, as the web’s CSS draws them', () => {
    it('bullets: disc, then circle at any deeper level', () => {
        expect([1, 2, 3].map(bulletMarker)).toEqual(['•', '◦', '◦']);
    });

    it('numbers: decimal, lower-alpha, lower-roman', () => {
        expect(numberMarker(3, 1)).toBe('3.');
        expect(numberMarker(3, 2)).toBe('c.');
        expect(numberMarker(28, 2)).toBe('ab.');
        expect(numberMarker(4, 3)).toBe('iv.');
        expect(numberMarker(1994, 3)).toBe('mcmxciv.');
    });

    it('gives numbers room for their widest marker', () => {
        expect(markerWidth(['•'], true)).toBe(20);
        expect(markerWidth(['1.', '10.'], false)).toBe(32);
    });
});

describe('blocks', () => {
    it('numbers from a list’s own start and nests bullets', async () => {
        await renderMarkdown('3. three\n4. four\n   - inner');
        expect(screen.getByText('3.')).toBeTruthy();
        expect(screen.getByText('4.')).toBeTruthy();
        expect(screen.getByText('•')).toBeTruthy();
        expect(screen.getByText('inner')).toBeTruthy();
    });

    it('draws task items with a checkbox and no marker', async () => {
        await renderMarkdown('- [ ] todo\n- [x] done');
        expect(screen.getByText('todo')).toBeTruthy();
        expect(screen.queryByText('•')).toBeNull();
    });

    it('marks headings as headers', async () => {
        await renderMarkdown('## Results\n\nBody');
        expect(screen.getByRole('header', { name: 'Results' })).toBeTruthy();
    });

    it('draws a table’s header and cells', async () => {
        await renderMarkdown('| Name | Score |\n|:--|--:|\n| Ann | **9** |');
        expect(screen.getByText('Name')).toBeTruthy();
        expect(screen.getByText('Ann')).toBeTruthy();
        expect(screen.getByText('9')).toBeTruthy();
    });

    it('decodes entities, drops raw HTML and keeps <br> as a break', async () => {
        await renderMarkdown('Fish &amp; chips <b>now</b> &#x1F600;<br>next');
        expect(screen.getByText("Fish & chips now 😀 next")).toBeTruthy();
    });

    it('turns a :::writing directive into a heading', async () => {
        await renderMarkdown(':::writing Draft reply\nHello there\n:::');
        expect(screen.getByRole('header', { name: 'Draft reply' })).toBeTruthy();
    });
});

describe('links', () => {
    it('opens a web page in a Custom Tab', async () => {
        await renderMarkdown('See [the docs](https://example.com/docs).');
        await fireEvent.press(screen.getByText('the docs'));
        expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://example.com/docs', { createTask: false });
    });

    it('draws a webpage or document link as a card, and opens its screen', async () => {
        await renderWithProviders(
            <ToastProvider>
                <MarkdownLinkProvider translate={(path) => ({ href: path.replace('/app/studio', '') })}>
                    <Markdown value="Your page is ready: [Q3 report](/app/studio/webpages/wp-1)" />
                </MarkdownLinkProvider>
            </ToastProvider>,
        );
        expect(screen.getByText('Your page is ready:')).toBeTruthy();
        await fireEvent.press(screen.getByText('Q3 report'));
        expect(mockPush).toHaveBeenCalledWith('/webpages/wp-1');
    });

    it('says so, instead of a sign-in on a bounced web page, for an app page the phone cannot show', async () => {
        // No native screen, and the web sends a phone's browser from Studio to the chat.
        await renderWithProviders(
            <ToastProvider>
                <MarkdownLinkProvider translate={() => null}>
                    <Markdown value="See [the rota](/app/studio/rota/r1) for this week." />
                </MarkdownLinkProvider>
            </ToastProvider>,
        );
        await fireEvent.press(screen.getByText('the rota'));
        expect(await screen.findByText('This link doesn’t open on the phone. Open it in Bee Flow on a computer.')).toBeTruthy();
        expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
        expect(mockPush).not.toHaveBeenCalled();
    });

    it('scrolls to a heading for an #anchor link when the screen offers a scroll host', async () => {
        const scrollTo = jest.fn();
        function Screen() {
            const ref = useRef<ScrollView>(null);
            return (
                <MarkdownScrollHostProvider host={{ scrollTo }}>
                    <ScrollView ref={ref}>
                        <Markdown value={'[Jump](#step-2-install)\n\n## Intro\n\n## Step 2: Installing'} />
                    </ScrollView>
                </MarkdownScrollHostProvider>
            );
        }
        await renderWithProviders(
            <ToastProvider>
                <Screen />
            </ToastProvider>,
        );
        await fireEvent.press(screen.getByText('Jump'));
        expect(scrollTo).toHaveBeenCalledTimes(1);
    });
});

describe('pictures', () => {
    it('draws a picture on its own line and opens it full screen', async () => {
        await renderMarkdown('Here: ![A chart](https://cdn.example.com/c.png) done');
        expect(screen.getByText('Here:')).toBeTruthy();
        expect(screen.getByText('done')).toBeTruthy();
        await fireEvent.press(screen.getByLabelText('A chart'));
        expect(screen.getByLabelText('Close image')).toBeTruthy();
        expect(screen.getByLabelText('Download')).toBeTruthy();
        expect(screen.getByLabelText('Share image')).toBeTruthy();
    });

    it('follows a linked picture’s link', async () => {
        await renderMarkdown('[![Logo](https://cdn.example.com/l.png)](https://example.com/home)');
        await fireEvent.press(screen.getByLabelText('Logo'));
        expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://example.com/home', { createTask: false });
    });
});
