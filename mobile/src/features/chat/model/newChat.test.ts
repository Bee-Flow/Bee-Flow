import { newChatHref, stageNewChatFiles, takeNewChatFiles } from './newChat';

describe('newChatHref', () => {
    it('sends only the draft when nothing else was set', () => {
        expect(newChatHref('Hi & bye', [], true)).toBe('/chat/new?draft=Hi%20%26%20bye');
    });

    it('carries the attached bases and a paused memory', () => {
        expect(newChatHref('Q', ['kb1', 'kb2'], false)).toBe('/chat/new?draft=Q&kb=kb1%2Ckb2&memory=off');
    });

    it('leaves the draft out of a files-only send', () => {
        expect(newChatHref('', [], true)).toBe('/chat/new');
        expect(newChatHref('', ['kb1'], true)).toBe('/chat/new?kb=kb1');
    });
});

describe('the files handed to a new chat', () => {
    const photo = { name: 'photo.jpg', mimeType: 'image/jpeg', uri: 'file:///cache/photo.jpg' };

    it('are taken once: the next new chat gets none', () => {
        stageNewChatFiles([photo]);
        expect(takeNewChatFiles()).toEqual([photo]);
        expect(takeNewChatFiles()).toEqual([]);
    });

    it('are the last send’s only', () => {
        stageNewChatFiles([photo]);
        stageNewChatFiles([]);
        expect(takeNewChatFiles()).toEqual([]);
    });
});
