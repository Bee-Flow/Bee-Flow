/**
 * Editor kind switch: Media + Text, Showcase and the Content video element all
 * offer "Clip (video with sound)" next to the silent loop.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../utils/helpers', async (importOriginal) => ({
    ...await importOriginal(),
    authFetch: vi.fn(async () => new Response(JSON.stringify({ assets: [], unavailable: true }), { status: 200 })),
}));

import { MediaTextEditor } from './MediaTextEditor';
import { ShowcaseEditor } from './ShowcaseEditor';

// FieldSelect's label is not bound to the <select>; find it next to its label.
const mediaTypeSelect = () => screen.getByText('Media type').parentElement.querySelector('select');

describe('MediaTextEditor', () => {
    it('offers the clip kind and writes kind: clip', async () => {
        const onChange = vi.fn();
        render(<MediaTextEditor data={{ media: { kind: 'image', src: '' } }} onChange={onChange} />);
        await userEvent.click(screen.getByText('Media'));
        const select = mediaTypeSelect();
        expect([...select.options].map(o => o.value)).toEqual(['image', 'gif', 'video', 'video-silent', 'clip']);
        await userEvent.selectOptions(select, 'clip');
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ media: expect.objectContaining({ kind: 'clip' }) }));
    });

    it('shows clip, poster and captions fields for a clip, and the language once captions exist', () => {
        const data = { media: { kind: 'clip', src: '/api/cms/asset/cms/1-a.mp4', captionsSrc: '/api/cms/asset/cms/1-a.en.vtt' } };
        render(<MediaTextEditor data={data} onChange={() => {}} />);
        expect(screen.getByText(/^Clip \(MP4/)).toBeInTheDocument();
        expect(screen.getByText('Poster image (optional)')).toBeInTheDocument();
        expect(screen.getByText('Captions (optional, .vtt)')).toBeInTheDocument();
        expect(screen.getByText('Captions language')).toBeInTheDocument();
        expect(screen.getByText('Upload clip')).toBeInTheDocument();
    });
});

describe('ShowcaseEditor', () => {
    it('lists silent loop and clip as separate options', () => {
        render(<ShowcaseEditor data={{ media: { kind: 'clip' } }} onChange={() => {}} />);
        const select = mediaTypeSelect();
        expect([...select.options].map(o => o.value)).toEqual(['image', 'video', 'clip']);
        expect(select.value).toBe('clip');
        expect(screen.getByText('Upload clip')).toBeInTheDocument();
    });
});
