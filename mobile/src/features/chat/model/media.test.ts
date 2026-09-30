/** Generated media: who gets the session's headers, and what a download is called. */

import { fileMeta, isDeck, isOwnServer, mediaFileName, mediaSource } from './media';

const HEADERS = { Authorization: 'Bearer x' };

it("sends the session's headers to this server only", () => {
    const own = mediaSource({ url: '/api/storage/a.mp3', mimeType: 'audio/mpeg' }, 'https://bee.example', HEADERS);
    const elsewhere = mediaSource({ url: 'https://cdn.other/a.mp3', mimeType: 'audio/mpeg' }, 'https://bee.example', HEADERS);
    expect(own && isOwnServer(own)).toBe(true);
    expect(own?.uri).toBe('https://bee.example/api/storage/a.mp3');
    expect(elsewhere && isOwnServer(elsewhere)).toBe(false);
});

it('names a download after its URL, or after its type', () => {
    expect(mediaFileName('/api/storage/song%201.mp3?x=1', 'audio/mpeg', 'audio')).toBe('song 1.mp3');
    expect(mediaFileName('/api/storage/abc', 'video/mp4', 'video')).toBe('video.mp4');
});

it('describes a built file the way the web does', () => {
    const slides = (n: number) => `${n} slides`;
    expect(fileMeta({ slideCount: 12, size: 1_468_006, path: '/Decks/q3.pptx' }, slides)).toBe('12 slides · 1.4 MB · /Decks/q3.pptx');
    expect(fileMeta({ size: 300 }, slides)).toBe('1 KB');
    expect(isDeck({ name: 'Q3.PPTX' })).toBe(true);
    expect(isDeck({ kind: 'document', name: 'notes.docx' })).toBe(false);
});
