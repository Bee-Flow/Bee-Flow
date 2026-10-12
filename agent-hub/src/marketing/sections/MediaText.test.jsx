/**
 * Media + Text must not publish a placeholder.
 *
 * Every branch of its renderMedia() draws something — a framed skeleton when
 * `frame` is set, an "Add an image in the panel" box otherwise — so a block
 * written without art put one of those on the public site with no warning.
 * Nine of them shipped on the Bee Flow site before anyone noticed, because
 * nothing in the authoring path says "you left this empty".
 *
 * Features and Steps already skip an empty media slot. These tests pin the
 * same rule here, and pin the one place a placeholder is still correct: the
 * CMS editor's preview, where it is the affordance telling you an image goes
 * there.
 *
 * Run: cd agent-hub && npx vitest run src/marketing/sections/MediaText.test.jsx
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import MediaText from './MediaText';

const base = {
    enabled: true,
    heading: 'Automation with a brake pedal',
    body: 'Approval steps hold anything irreversible until a person agrees.',
    cta: null,
    mediaPosition: 'right',
    mediaSize: 'half',
    backgroundVariant: 'default',
};

// Relative, so jsdom's configured origin is preserved — an absolute URL with
// a different host throws SecurityError.
function setPreview(on) {
    window.history.replaceState({}, '', on ? '?preview=1' : '?');
}

afterEach(() => setPreview(false));

describe('on the published site', () => {
    it('renders text-only when the media slot is empty', () => {
        const { container } = render(
            <MediaText data={{ ...base, media: { kind: 'image', src: '', alt: '', frame: 'hairline' } }} />
        );

        expect(screen.getByText(base.heading)).toBeInTheDocument();
        expect(container.querySelector('.media-text-block-media')).toBeNull();
        expect(container.querySelector('.media-text-block-inner--no-media')).not.toBeNull();
    });

    it('shows no "Add an image" prompt to a visitor', () => {
        render(<MediaText data={{ ...base, media: { kind: 'image', src: '', alt: '', frame: '' } }} />);
        expect(screen.queryByText(/Add an image/i)).toBeNull();
    });

    it('treats whitespace as empty — a stray space is not an image', () => {
        const { container } = render(
            <MediaText data={{ ...base, media: { kind: 'image', src: '   ', alt: '', frame: 'hairline' } }} />
        );
        expect(container.querySelector('.media-text-block-media')).toBeNull();
    });

    it('still renders the media column when there IS an image', () => {
        const { container } = render(
            <MediaText data={{ ...base, media: { kind: 'image', src: 'cms/shot.png', alt: 'A screenshot', frame: 'hairline' } }} />
        );
        expect(container.querySelector('.media-text-block-media')).not.toBeNull();
        expect(container.querySelector('.media-text-block-inner--no-media')).toBeNull();
    });

    it('keeps the layout knobs when media is present', () => {
        const { container } = render(
            <MediaText data={{ ...base, mediaSize: 'two-thirds', media: { kind: 'image', src: 'cms/shot.png', alt: '', frame: '' } }} />
        );
        expect(container.querySelector('.media-text-block-inner--size-two-thirds')).not.toBeNull();
        expect(container.querySelector('.media-text-block-inner--position-right')).not.toBeNull();
    });
});

describe('in the CMS editor preview', () => {
    it('keeps the placeholder, because that is where it is an affordance', () => {
        setPreview(true);
        const { container } = render(
            <MediaText data={{ ...base, media: { kind: 'image', src: '', alt: '', frame: '' } }} />
        );
        expect(container.querySelector('.media-text-block-media')).not.toBeNull();
        expect(screen.getByText(/Add an image/i)).toBeInTheDocument();
    });
});

describe('clip (video with sound)', () => {
    const clip = {
        kind: 'clip',
        src: '/api/cms/asset/cms/1-demo.mp4',
        poster: '/api/cms/asset/cms/1-poster.jpg',
        captionsSrc: '/api/cms/asset/cms/1-demo.en.vtt',
        captionsLang: 'nl',
        alt: 'Demo of the approval step',
    };

    it('renders a player with controls and sound, never autoplay or muted', () => {
        const { container } = render(<MediaText data={{ ...base, media: clip }} />);
        const video = container.querySelector('video');
        expect(video).not.toBeNull();
        expect(video.getAttribute('src')).toBe(clip.src);
        expect(video.getAttribute('poster')).toBe(clip.poster);
        expect(video.hasAttribute('controls')).toBe(true);
        expect(video.getAttribute('preload')).toBe('metadata');
        expect(video.hasAttribute('playsinline')).toBe(true);
        expect(video.autoplay).toBe(false);
        expect(video.muted).toBe(false);
        expect(video.hasAttribute('loop')).toBe(false);
        expect(video.getAttribute('aria-label')).toBe('Demo of the approval step');
    });

    it('adds a default captions track in the given language', () => {
        const { container } = render(<MediaText data={{ ...base, media: clip }} />);
        const track = container.querySelector('video track');
        expect(track).not.toBeNull();
        expect(track.getAttribute('kind')).toBe('captions');
        expect(track.getAttribute('src')).toBe(clip.captionsSrc);
        expect(track.getAttribute('srclang')).toBe('nl');
        expect(track.hasAttribute('default')).toBe(true);
    });

    it('has no track and no poster when none were uploaded', () => {
        const { container } = render(<MediaText data={{ ...base, media: { kind: 'clip', src: clip.src } }} />);
        expect(container.querySelector('video track')).toBeNull();
        expect(container.querySelector('video').hasAttribute('poster')).toBe(false);
    });

    it('leaves the silent loop exactly as it was: autoplay, muted, loop, no controls', () => {
        const { container } = render(
            <MediaText data={{ ...base, media: { kind: 'video-silent', src: clip.src, alt: '' } }} />
        );
        const video = container.querySelector('video');
        expect(video.hasAttribute('autoplay')).toBe(true);
        expect(video.hasAttribute('loop')).toBe(true);
        expect(video.hasAttribute('controls')).toBe(false);
    });

    it('shows the upload prompt in the editor preview when empty, nothing on the public site', () => {
        setPreview(true);
        render(<MediaText data={{ ...base, media: { kind: 'clip', src: '' } }} />);
        expect(screen.getByText(/Upload a clip/i)).toBeInTheDocument();
        setPreview(false);
        const { container } = render(<MediaText data={{ ...base, media: { kind: 'clip', src: '' } }} />);
        expect(container.querySelector('.media-text-block-media')).toBeNull();
    });
});
