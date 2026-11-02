/**
 * An embed in a Content block can take the full content-container width.
 *
 * A single column is an 800px reading column, which is right for text and
 * wrong for a live product demo: the app surface inside lays out cramped and
 * reads small. `fullBleed` on an iframe element breaks the frame out of its
 * column, the same switch an image already has; without it nothing changes,
 * so existing embeds (a booking widget, a map) keep their width.
 *
 * Run: cd agent-hub && npx vitest run src/marketing/sections/Content.iframe.test.tsx
 */
import { render } from '@testing-library/react';
import React from 'react';
import { describe, it, expect } from 'vitest';
import Content from './Content';

function block(iframe: Record<string, unknown>) {
    return {
        enabled: true,
        columnLayout: '1',
        columns: [{
            id: 'col_1',
            elements: [
                { id: 'el_t', kind: 'text', heading: 'Try the builder', body: '', align: 'center' },
                { id: 'el_f', kind: 'iframe', src: 'https://example.com/__demo__/automations', height: 640, label: 'Demo', ...iframe },
            ],
        }],
    };
}

function frameWrap(container: HTMLElement) {
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    return iframe!.parentElement!;
}

describe('Content iframe width', () => {
    it('breaks the frame out of its column when fullBleed is set', () => {
        const { container } = render(<Content data={block({ fullBleed: true })} />);
        expect(frameWrap(container).className).toContain('content-el-iframe--bleed');
        expect(container.querySelector('iframe')!.getAttribute('height')).toBe('640');
    });

    it('keeps the column width without it', () => {
        const { container } = render(<Content data={block({})} />);
        expect(frameWrap(container).className).toContain('content-el-iframe');
        expect(frameWrap(container).className).not.toContain('content-el-iframe--bleed');
    });

    it('reads only a real true, not a truthy string', () => {
        const { container } = render(<Content data={block({ fullBleed: 'yes' })} />);
        expect(frameWrap(container).className).not.toContain('content-el-iframe--bleed');
    });
});
