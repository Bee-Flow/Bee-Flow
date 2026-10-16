/**
 * The feature-demo block starts as a poster (a button) and creates the live
 * iframe only after a click or keypress, so a visitor who scrolls past never
 * downloads the demo. On a phone there is no iframe at all: the poster is a
 * link into /__demo__/<id>?vw=1280. The iframe's containment attributes are
 * the sandbox half of the demo security story and stay pinned exactly. The
 * CMS editor's poster is inert, so the builder never boots a second app.
 *
 * jsdom reports clientWidth 0, so these tests assert structure and
 * attributes, never measured pixels (the stance src/test/setup.js documents).
 *
 * Run: cd agent-hub && npx vitest run src/marketing/sections/FeatureDemo.test.jsx
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import FeatureDemo from './FeatureDemo';

const base = {
    enabled: true,
    feature: 'automations',
    height: 760,
    theme: 'light',
    title: 'The actual builder',
    note: 'Sample data only.',
    cta: { label: 'Start in the app', link: { href: '/app' } },
};

// Relative, so jsdom's configured origin is preserved — an absolute URL with
// a different host throws SecurityError.
function setPreview(on: boolean) {
    window.history.replaceState({}, '', on ? '?preview=1' : '?');
}

// The setup-file stub only installs itself when matchMedia is missing, so a
// per-test swap (restored in afterEach) is safe and does not fight it.
let originalMatchMedia: typeof window.matchMedia;
function setPhone(on: boolean) {
    window.matchMedia = (query: string) => ({
        matches: on && query === '(max-width: 768px)',
        media: String(query || ''),
        onchange: null,
        addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {},
        dispatchEvent() { return false; },
    });
}

beforeEach(() => { originalMatchMedia = window.matchMedia; });
afterEach(() => {
    window.matchMedia = originalMatchMedia;
    setPreview(false);
});

const CONTAINMENT = {
    sandbox: 'allow-scripts allow-same-origin',
    allow: '',
    referrerpolicy: 'no-referrer',
    loading: 'lazy',
};

function expectContainment(iframe: Element) {
    for (const [attr, value] of Object.entries(CONTAINMENT)) {
        expect(iframe.getAttribute(attr), attr).toBe(value);
    }
}

describe('on desktop', () => {
    beforeEach(() => setPhone(false));

    it('renders a poster button and no iframe before any interaction', () => {
        const { container } = render(<FeatureDemo data={base} />);

        expect(container.querySelector('iframe')).toBeNull();
        expect(screen.getByRole('button', { name: /try it/i })).toBeInTheDocument();
    });

    it('creates the iframe with the exact containment attributes on click', async () => {
        const { container } = render(<FeatureDemo data={base} />);
        await userEvent.click(screen.getByRole('button', { name: /try it/i }));

        const iframe = container.querySelector('iframe.feature-demo-iframe') as HTMLElement;
        expect(iframe).not.toBeNull();
        expect(iframe.getAttribute('src')).toBe('/__demo__/automations?theme=light&lang=en');
        expectContainment(iframe);
        expect(container.querySelector('.feature-demo-poster')).toBeNull();
    });

    it('creates the iframe on a keypress too', async () => {
        const { container } = render(<FeatureDemo data={base} />);
        screen.getByRole('button', { name: /try it/i }).focus();
        await userEvent.keyboard('{Enter}');
        expect(container.querySelector('iframe')).not.toBeNull();
    });

    it('fixes the aspect ratio from the block height, so activation shifts nothing', () => {
        const { container } = render(<FeatureDemo data={base} />);
        const frame = container.querySelector('.feature-demo-frame') as HTMLElement;
        expect(frame.style.aspectRatio).toBe('1280 / 760');
        expect(frame.style.height).toBe('');
    });

    it('shows the authored poster image and caption', () => {
        const { container } = render(
            <FeatureDemo data={{ ...base, poster: '/api/cms/asset/cms/shot.png', caption: 'Drag a step onto the canvas.' }} />,
        );
        expect(container.querySelector('img.feature-demo-poster-img')?.getAttribute('src')).toBe('/api/cms/asset/cms/shot.png');
        expect(screen.getByText('Drag a step onto the canvas.')).toBeInTheDocument();
    });

    it('renders no image and no caption when none is authored', () => {
        const { container } = render(<FeatureDemo data={base} />);
        expect(container.querySelector('img')).toBeNull();
        expect(container.querySelector('.feature-demo-caption')).toBeNull();
    });

    it('shows no mobile chrome', () => {
        const { container } = render(<FeatureDemo data={base} />);
        expect(container.querySelector('.feature-demo-open-btn')).toBeNull();
    });
});

describe('on a phone', () => {
    beforeEach(() => setPhone(true));

    it('never creates an iframe, not even a scaled thumbnail', () => {
        const { container } = render(<FeatureDemo data={base} />);
        expect(container.querySelector('iframe')).toBeNull();
        expect(container.querySelector('.feature-demo-scale-clip')).toBeNull();
    });

    it('links the poster and the footer button to the full-screen demo, same tab', () => {
        const { container } = render(<FeatureDemo data={base} />);

        const poster = container.querySelector('a.feature-demo-poster') as HTMLElement;
        const button = container.querySelector('a.feature-demo-open-btn') as HTMLElement;
        for (const link of [poster, button]) {
            expect(link).not.toBeNull();
            expect(link.getAttribute('href')).toBe('/__demo__/automations?theme=light&lang=en&vw=1280');
            // Same tab on purpose: the demo host's close button relies on
            // history.back() landing on this exact page.
            expect(link.getAttribute('target')).toBeNull();
        }
        expect(button.textContent).toMatch(/Open full screen/);
        expect(screen.getByText('Sample data only.')).toBeInTheDocument();
        expect(screen.getByText('Start in the app')).toBeInTheDocument();
    });

    it('carries a dark theme into the full-screen URL', () => {
        const { container } = render(<FeatureDemo data={{ ...base, theme: 'dark' }} />);
        expect((container.querySelector('a.feature-demo-poster') as HTMLElement).getAttribute('href'))
            .toBe('/__demo__/automations?theme=dark&lang=en&vw=1280');
    });

    it('still renders the placeholder for an unknown feature, no iframe, no links', () => {
        const { container } = render(<FeatureDemo data={{ ...base, feature: 'not-a-feature' }} />);

        expect(container.querySelector('.feature-demo-placeholder')).not.toBeNull();
        expect(container.querySelector('iframe')).toBeNull();
        expect(container.querySelector('a.feature-demo-poster')).toBeNull();
        expect(container.querySelector('.feature-demo-open-btn')).toBeNull();
    });
});

describe('in the CMS editor preview', () => {
    it('shows an inert poster, no button, link or iframe, on desktop and phone', () => {
        setPreview(true);
        for (const phone of [false, true]) {
            setPhone(phone);
            const { container, unmount } = render(<FeatureDemo data={base} />);
            expect(container.querySelector('.feature-demo-poster')).not.toBeNull();
            expect(container.querySelector('button')).toBeNull();
            expect(container.querySelector('a.feature-demo-poster')).toBeNull();
            expect(container.querySelector('iframe')).toBeNull();
            unmount();
        }
    });
});

describe('a disabled block', () => {
    it.each([['desktop', false], ['phone', true]])('renders nothing on %s', (_label, phone) => {
        setPhone(phone);
        const { container } = render(<FeatureDemo data={{ ...base, enabled: false }} />);
        expect(container.firstChild).toBeNull();
    });
});
