import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { resolveNodeStyle } from '../styleResolver';
import type { StyleKnobs } from '../styleResolver.types';
import { extensionKnobGroups } from '../catalogSnapshot.generated.json';
import BackgroundImageLayer from '../assets/BackgroundImageLayer';
import { AssetTransportProvider } from '../assets/assetTransport';
import backdropHandler from './backdrop';
import hoverHandler, { HOVER_CLASSES } from './hover';

const resolve = (style: Record<string, unknown>) => resolveNodeStyle({ style: style as StyleKnobs });

describe('hover knob group', () => {
    it('each preset is one class on the cell; none, absent and unknown add nothing', () => {
        const base = resolve({ span: 6 });
        for (const [value, cls] of Object.entries(HOVER_CLASSES)) {
            expect(resolve({ span: 6, hover: value }).className).toBe(`${base.className} ${cls}`);
            expect(resolve({ span: 6, hover: value }).style).toEqual(base.style);
        }
        expect(resolve({ span: 6, hover: 'none' })).toEqual(base);
        expect(resolve({ span: 6, hover: 'sparkle' })).toEqual(base);
    });

    it('the handler names every knob of the group and draws on the node only', () => {
        const group = extensionKnobGroups.find((g) => g.name === 'hover');
        expect(Object.keys(hoverHandler.labels ?? {}).sort()).toEqual([...(group?.knobs ?? [])].sort());
        expect(hoverHandler.section).toBeUndefined();
    });
});

describe('backdrop knob group', () => {
    it('marks the cell only when a picture is set', () => {
        const base = resolve({ span: 6 });
        expect(resolve({ span: 6, backgroundImage: 'asset:abc' }).className).toBe(`${base.className} app-has-backdrop`);
        expect(resolve({ span: 6, backgroundFit: 'tile', backgroundOverlay: 'dim' })).toEqual(base);
        expect(resolve({ span: 6, backgroundImage: 'https://example.com/a.png' })).toEqual(base);
    });

    it('the handler names every knob of the group', () => {
        const group = extensionKnobGroups.find((g) => g.name === 'backdrop');
        expect(Object.keys(backdropHandler.labels ?? {}).sort()).toEqual([...(group?.knobs ?? [])].sort());
    });

    it('the layer addresses the asset through the page transport, never by a hand-built URL', () => {
        const signedIn = render(
            <AssetTransportProvider publicToken={null}><BackgroundImageLayer image="asset:abc" fit="tile" overlay="dim" /></AssetTransportProvider>,
        );
        // No data scope in this test: nothing to address the asset by, so nothing is drawn.
        expect(signedIn.container.querySelector('[data-app-backdrop]')).toBeNull();
        signedIn.unmount();

        const pub = render(
            <AssetTransportProvider publicToken="f00d"><BackgroundImageLayer image="asset:abc" fit="tile" overlay="dim" /></AssetTransportProvider>,
        );
        const layer = pub.container.querySelector('[data-app-backdrop]') as HTMLElement;
        expect(layer.dataset.fit).toBe('tile');
        expect(layer.dataset.overlay).toBe('dim');
        expect(layer.style.getPropertyValue('--app-backdrop-image')).toContain('/api/public-app/f00d/assets/abc');
        pub.unmount();

        const none = render(
            <AssetTransportProvider publicToken="f00d"><BackgroundImageLayer image="https://example.com/a.png" /></AssetTransportProvider>,
        );
        expect(none.container.querySelector('[data-app-backdrop]')).toBeNull();
    });

    it('an unknown fit or veil falls back to cover and none', () => {
        const r = render(
            <AssetTransportProvider publicToken="f00d"><BackgroundImageLayer image="asset:abc" fit="stretch" overlay="red" /></AssetTransportProvider>,
        );
        const layer = r.container.querySelector('[data-app-backdrop]') as HTMLElement;
        expect(layer.dataset.fit).toBe('cover');
        expect(layer.dataset.overlay).toBe('none');
    });
});
