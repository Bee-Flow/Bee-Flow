/**
 * The demo iframe (created on click) carries the language of the page around
 * it as ?lang=, so a Dutch page does not frame an English UI.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach } from 'vitest';
import FeatureDemo from './FeatureDemo';

const data = { enabled: true, feature: 'automations', theme: 'light', title: 'Demo' };

afterEach(() => window.history.replaceState({}, '', '/'));

async function frameSrcAt(url: string): Promise<string | null | undefined> {
    window.history.replaceState({}, '', url);
    const { container, unmount } = render(<FeatureDemo data={data} />);
    await userEvent.click(screen.getByRole('button', { name: /try it/i }));
    const src = container.querySelector('iframe')?.getAttribute('src');
    unmount();
    return src;
}

describe('feature-demo language', () => {
    it('passes lang=nl on a /nl page', async () => {
        expect(await frameSrcAt('/nl/product')).toContain('lang=nl');
    });

    it('passes lang=en on an English page', async () => {
        expect(await frameSrcAt('/product')).toContain('lang=en');
    });

    it('falls back to ?locale= on an unprefixed page, like the cookie banner', async () => {
        expect(await frameSrcAt('/product?locale=nl')).toContain('lang=nl');
    });

    it('lets the path prefix win over ?locale=, and ignores an unknown ?locale=', async () => {
        expect(await frameSrcAt('/nl/product?locale=en')).toContain('lang=nl');
        expect(await frameSrcAt('/product?locale=xx')).toContain('lang=en');
    });
});
