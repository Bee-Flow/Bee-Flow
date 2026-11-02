/**
 * Fenced blocks rendered straight from model output (json-research, json-page,
 * json-test-report, map) do not fetch from another host by themselves: a
 * remote image waits for a click like a Markdown image, and a map is framed
 * only when it is a Google Maps embed.
 *
 * Run: cd agent-hub && npx vitest run src/components/renderers/fencedImages.test.tsx
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';


import ResearchRenderer from './ResearchRenderer';
import PageRenderer from './PageRenderer';
import MapEmbedRenderer from './MapEmbedRenderer';
import { TestReportRendererSection } from './TestReportRendererSection';
import { trustedMapEmbedUrl } from './mapEmbedUrl';
import type { ResearchData } from './ResearchRenderer.types';
import type { TestCase } from './TestReportRenderer.types';

const REMOTE = 'https://collector.example/p.png?d=secret';

function remoteImgs(container: HTMLElement) {
    return Array.from(container.querySelectorAll('img')).filter(i => (i.getAttribute('src') || '').startsWith('https://collector.example'));
}

describe('fenced renderers keep remote images behind a click', () => {
    it('research hero and image blocks', () => {
        const data = { title: 'R', blocks: [
            { type: 'hero', title: 'H', image: REMOTE },
            { type: 'image', src: REMOTE, alt: 'chart' },
        ] } as unknown as ResearchData;
        const { container } = render(<ResearchRenderer data={data} />);
        expect(remoteImgs(container)).toHaveLength(0);
        expect(screen.getAllByTestId('remote-image-deferred')).toHaveLength(2);
    });

    it('page image element', () => {
        const { container } = render(<PageRenderer code={{ type: 'page', children: [{ type: 'image', src: REMOTE, alt: 'x' }] }} onAction={undefined} />);
        expect(remoteImgs(container)).toHaveLength(0);
        expect(screen.getByTestId('remote-image-deferred')).toBeTruthy();
    });

    it('page image on this origin still loads', () => {
        const { container } = render(<PageRenderer code={{ type: 'page', children: [{ type: 'image', src: '/api/files/1', alt: 'x' }] }} onAction={undefined} />);
        expect(container.querySelector('img[src="/api/files/1"]')).toBeTruthy();
    });

    it('test report screenshot', () => {
        const tests = [
            { name: 'a', status: 'failed', category: 'ui', screenshot: REMOTE },
            { name: 'b', status: 'failed', category: 'ui', screenshot: 'data:image/png;base64,iVBORw0KGgo=' },
        ] as unknown as TestCase[];
        const status = { failed: { color: '#f00', bg: '#000', icon: <span />, label: 'Failed' }, skipped: { color: '#888', bg: '#000', icon: <span />, label: 'Skipped' } };
        const { container } = render(
            <TestReportRendererSection
                filteredTests={tests} filter="all" t={(_k, fb) => (typeof fb === 'string' ? fb : '')}
                statusConfig={status} categoryConfig={{}} expandedTests={new Set([0, 1])}
                severityColors={{}} toggleTest={() => {}}
            />,
        );
        expect(remoteImgs(container)).toHaveLength(0);
        expect(screen.getByTestId('remote-image-deferred')).toBeTruthy();
        expect(container.querySelector('img[src^="data:image/png"]')).toBeTruthy();
    });
});

describe('map embeds', () => {
    it('frames only the Google Maps embed API', () => {
        expect(trustedMapEmbedUrl('https://www.google.com/maps/embed/v1/search?key=k&q=x')).toBeTruthy();
        expect(trustedMapEmbedUrl('https://www.google.com/maps/embed?pb=1')).toBeTruthy();
        expect(trustedMapEmbedUrl('/share/abc/content')).toBeNull();
        expect(trustedMapEmbedUrl(`${window.location.origin}/share/abc/content`)).toBeNull();
        expect(trustedMapEmbedUrl('https://www.google.com.evil.example/maps/embed')).toBeNull();
        expect(trustedMapEmbedUrl('https://www.google.com/mapsx/embed')).toBeNull();
        expect(trustedMapEmbedUrl('http://www.google.com/maps/embed')).toBeNull();
        expect(trustedMapEmbedUrl('javascript:alert(1)')).toBeNull();
    });

    it('renders a sandboxed iframe for a Google Maps embed', () => {
        const { container } = render(<MapEmbedRenderer embedUrl="https://www.google.com/maps/embed/v1/search?key=k&q=x" title="T" />);
        const frame = container.querySelector('iframe');
        expect(frame?.getAttribute('src')).toMatch(/^https:\/\/www\.google\.com\/maps\/embed\//);
        expect(frame?.getAttribute('sandbox')).toBeTruthy();
    });

    it('renders no iframe for a same-origin page, only a link', () => {
        const url = `${window.location.origin}/share/abc/content`;
        const { container } = render(<MapEmbedRenderer embedUrl={url} title="T" />);
        expect(container.querySelector('iframe')).toBeNull();
        expect(screen.getByTestId('map-embed-link').getAttribute('href')).toBe(url);
    });

    it('renders nothing for a non-http URL', () => {
        const { container } = render(<MapEmbedRenderer embedUrl="javascript:alert(1)" />);
        expect(container.querySelector('iframe')).toBeNull();
        expect(container.querySelector('a')).toBeNull();
    });
});
