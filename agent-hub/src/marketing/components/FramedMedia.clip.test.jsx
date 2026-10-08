/**
 * Showcase renders through FramedMedia: a clip there is a real player
 * (controls, poster, captions), the silent loop is untouched.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import FramedMedia from './FramedMedia';

describe('FramedMedia clip', () => {
    it('renders a controlled player with captions inside the frame', () => {
        const { container } = render(
            <FramedMedia media={{
                kind: 'clip', src: 'cms/1-demo.mp4', poster: 'cms/1-p.jpg',
                captionsSrc: 'cms/1-demo.en.vtt', captionsLang: 'en', frame: 'browser',
            }} />
        );
        const video = container.querySelector('.cms-frame video');
        expect(video.getAttribute('src')).toBe('/api/cms/asset/cms/1-demo.mp4');
        expect(video.getAttribute('poster')).toBe('/api/cms/asset/cms/1-p.jpg');
        expect(video.hasAttribute('controls')).toBe(true);
        expect(video.hasAttribute('autoplay')).toBe(false);
        expect(container.querySelector('video track').getAttribute('src')).toBe('/api/cms/asset/cms/1-demo.en.vtt');
    });

    it('keeps kind video as the silent autoplay loop', () => {
        const { container } = render(<FramedMedia media={{ kind: 'video', src: 'cms/1-loop.mp4' }} />);
        const video = container.querySelector('video');
        expect(video.hasAttribute('autoplay')).toBe(true);
        expect(video.hasAttribute('controls')).toBe(false);
    });
});
