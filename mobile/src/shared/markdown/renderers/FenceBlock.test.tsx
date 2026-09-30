/**
 * Fenced blocks as the web's CodeRenderer routes them: code to the code
 * block, workspace to nothing, the rich languages to their native renderers,
 * a fence still streaming in to the "Building…" placeholder, and anything a
 * renderer cannot read to its code.
 */

import { act, fireEvent, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';

import { fence, renderMarkdown } from '@/shared/testing/renderMarkdown';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

describe('code', () => {
    it('draws a language-tagged block with its header, and copies it', async () => {
        await renderMarkdown(fence('py', 'def f(x):\n    return x + 1\n\nprint(f(2))'));
        expect(screen.getByText('● Python')).toBeTruthy();
        await fireEvent.press(screen.getByLabelText('Copy code'));
        expect(Clipboard.setStringAsync).toHaveBeenCalledWith('def f(x):\n    return x + 1\n\nprint(f(2))');
        expect(screen.getByText('Copied')).toBeTruthy();
    });

    it('highlights once the text has settled', async () => {
        jest.useFakeTimers();
        await renderMarkdown(fence('ts', 'const answer: number = 42;\nexport default answer;'));
        await act(async () => {
            jest.advanceTimersByTime(200);
        });
        // "const" is a keyword run of its own once highlighted.
        expect(screen.getByText('const')).toBeTruthy();
        jest.useRealTimers();
    });

    it('draws a short fence with no language as the compact chip', async () => {
        await renderMarkdown(`Run this:\n\n${fence('', 'npm run build')}`);
        expect(screen.getByText('npm run build')).toBeTruthy();
        expect(screen.queryByLabelText('Copy code')).toBeNull();
    });

    it('hides a workspace block, which the workspace tool shows', async () => {
        await renderMarkdown(`Before\n\n${fence('workspace', 'secret draft')}\n\nAfter`);
        expect(screen.queryByText(/secret draft/)).toBeNull();
        expect(screen.getByText('After')).toBeTruthy();
    });
});

describe('rich blocks', () => {
    const research = JSON.stringify({
        title: 'AI in Healthcare',
        blocks: [
            { type: 'stats', items: [{ value: '78%', label: 'Adoption Rate' }] },
            { type: 'callout', variant: 'warning', title: 'Bias Risk', content: 'Imbalanced data.' },
            { type: 'sources', items: [{ url: 'https://www.who.int/report', title: 'WHO report' }] },
        ],
    });

    it('shows the web’s placeholder while a rich fence is still streaming in', async () => {
        await renderMarkdown(fence('json-research', research.slice(0, 40), false));
        expect(screen.getByText('Building research report…')).toBeTruthy();
    });

    it('draws a finished research report', async () => {
        await renderMarkdown(fence('json-research', research));
        expect(screen.getByText('AI in Healthcare')).toBeTruthy();
        expect(screen.getByText('78%')).toBeTruthy();
        expect(screen.getByText('Bias Risk')).toBeTruthy();
        expect(screen.getByText('WHO report')).toBeTruthy();
        expect(screen.getByText('who.int')).toBeTruthy();
    });

    it('treats an unclosed fence as finished once the stream has ended', async () => {
        await renderMarkdown(fence('json-research', research, false), { streaming: false });
        expect(screen.getByText('AI in Healthcare')).toBeTruthy();
    });

    it('shows broken JSON as its code rather than a spinner that never ends', async () => {
        await renderMarkdown(fence('json-research', '{"title": "x", "blocks": [ oops ]}'));
        expect(screen.queryByText('Building research report…')).toBeNull();
        expect(screen.getByText('● Json-research')).toBeTruthy();
    });

    it('draws a test report and filters it by status', async () => {
        const report = JSON.stringify({
            title: 'Checkout QA',
            tests: [
                { name: 'Login works', status: 'passed' },
                { name: 'Pay button', status: 'failed', error: 'Button disabled', steps: ['Open cart'] },
            ],
            recommendations: ['Enable the button'],
        });
        await renderMarkdown(fence('test-report', report));
        expect(screen.getByText('🧪 Checkout QA')).toBeTruthy();
        expect(screen.getByText('50%')).toBeTruthy();
        await fireEvent.press(screen.getByText('Pay button'));
        expect(screen.getByText('Button disabled')).toBeTruthy();
        await fireEvent.press(screen.getByText('Passed'));
        expect(screen.queryByText('Pay button')).toBeNull();
        expect(screen.getByText('• Enable the button')).toBeTruthy();
    });

    it('draws a page and opens a button’s overlay', async () => {
        const page = JSON.stringify({
            type: 'page',
            title: 'Dashboard',
            children: [
                { type: 'stat', value: '1.2k', label: 'Visitors', change: 12, color: 'green' },
                { type: 'button', text: 'Details', description: 'All the details' },
                { type: 'tabs', tabs: [{ label: 'One', children: [{ type: 'text', text: 'first' }] }, { label: 'Two', children: [{ type: 'text', text: 'second' }] }] },
            ],
        });
        await renderMarkdown(fence('json-page', page));
        expect(screen.getByText('Dashboard')).toBeTruthy();
        expect(screen.getByText('↑ 12%')).toBeTruthy();
        expect(screen.getByText('first')).toBeTruthy();
        await fireEvent.press(screen.getByText('Two'));
        expect(screen.getByText('second')).toBeTruthy();
        await fireEvent.press(screen.getByText('Details'));
        expect(screen.getByText('All the details')).toBeTruthy();
    });

    it('draws a map card that names the route', async () => {
        const map = JSON.stringify({
            title: 'To the office',
            embedUrl: 'https://www.google.com/maps/embed/v1/directions?key=k&origin=Utrecht&destination=Amsterdam&mode=driving',
        });
        await renderMarkdown(fence('map', map));
        expect(screen.getByText('📍 To the office')).toBeTruthy();
        expect(screen.getByText('Utrecht')).toBeTruthy();
        expect(screen.getByText('Amsterdam')).toBeTruthy();
    });

    it('draws a Vega-Lite chart, or its data when the spec is beyond the phone', async () => {
        const values = [{ c: 'A', v: 3 }, { c: 'B', v: 5 }];
        await renderMarkdown(fence('vega-lite', JSON.stringify({ title: 'Sales', data: { values }, mark: 'bar', encoding: { x: { field: 'c' }, y: { field: 'v' } } })));
        expect(screen.getByText('Sales')).toBeTruthy();
        await renderMarkdown(fence('vega-lite', JSON.stringify({ data: { values }, mark: 'bar', transform: [{ filter: 'x' }] })));
        expect(screen.getByText('This chart is shown as its data on the phone.')).toBeTruthy();
        expect(screen.getByText('B')).toBeTruthy();
    });

    it('draws a Mermaid flowchart, and leaves other diagram kinds as code', async () => {
        await renderMarkdown(fence('mermaid', 'graph TD\n  A[Start] --> B{Ok?}'));
        expect(screen.getByText('Expand')).toBeTruthy();
        await renderMarkdown(fence('mermaid', 'sequenceDiagram\n  A->>B: hi'));
        expect(screen.getByText('● Mermaid')).toBeTruthy();
    });
});
