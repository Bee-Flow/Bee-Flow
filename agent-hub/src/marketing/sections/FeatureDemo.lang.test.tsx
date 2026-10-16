/**
 * The demo iframe (and the phone "open full screen" link) carry the language of
 * the page around them as ?lang=, so a Dutch page does not frame an English UI.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import FeatureDemo from './FeatureDemo';

const data = { enabled: true, feature: 'automations', theme: 'light', title: 'Demo' };

afterEach(() => window.history.replaceState({}, '', '/'));

describe('feature-demo language', () => {
    it('passes lang=nl on a /nl page', () => {
        window.history.replaceState({}, '', '/nl/product');
        const { container } = render(<FeatureDemo data={data} />);
        expect(container.querySelector('iframe')?.getAttribute('src')).toContain('lang=nl');
    });

    it('passes lang=en on an English page', () => {
        window.history.replaceState({}, '', '/product');
        const { container } = render(<FeatureDemo data={data} />);
        expect(container.querySelector('iframe')?.getAttribute('src')).toContain('lang=en');
    });

    it('falls back to ?locale= on an unprefixed page, like the cookie banner', () => {
        window.history.replaceState({}, '', '/product?locale=nl');
        const { container } = render(<FeatureDemo data={data} />);
        expect(container.querySelector('iframe')?.getAttribute('src')).toContain('lang=nl');
    });

    it('lets the path prefix win over ?locale=, and ignores an unknown ?locale=', () => {
        window.history.replaceState({}, '', '/nl/product?locale=en');
        const first = render(<FeatureDemo data={data} />);
        expect(first.container.querySelector('iframe')?.getAttribute('src')).toContain('lang=nl');
        first.unmount();
        window.history.replaceState({}, '', '/product?locale=xx');
        const second = render(<FeatureDemo data={data} />);
        expect(second.container.querySelector('iframe')?.getAttribute('src')).toContain('lang=en');
    });
});
