/**
 * What a picked file may weigh, and what the send says when it is too much.
 *
 * The request carries at most TOTAL_ATTACHMENT_BUDGET of attachment bytes. A
 * photo is shrunk before it goes, so the picker holds it only to the per-file
 * ceiling; any other file goes as it is, so one over the budget is refused at
 * pick time. The send names one file that is too large on its own, and says
 * "together" only when several files are.
 */

import {
    AttachmentBudgetError,
    AttachmentTooLargeError,
    encodeAttachments,
    MAX_FILE_BYTES,
    overPickLimit,
    pickLimit,
    TOTAL_ATTACHMENT_BUDGET,
} from './attachments';

const mockBase64 = jest.fn(async () => 'QUJD');

jest.mock('expo-file-system', () => ({
    File: class {
        exists = true;
        size = 3;
        base64 = mockBase64;
    },
}));
jest.mock('expo-image-manipulator', () => ({ ImageManipulator: { manipulate: jest.fn() }, SaveFormat: { JPEG: 'jpeg' } }));

const MB = 1024 * 1024;

beforeEach(() => mockBase64.mockClear());

describe('at pick time', () => {
    it('holds a photo to the per-file ceiling and anything else to the whole budget', () => {
        expect(pickLimit('image/jpeg')).toBe(MAX_FILE_BYTES);
        expect(pickLimit('application/pdf')).toBe(TOTAL_ATTACHMENT_BUDGET);
        expect(pickLimit(undefined)).toBe(TOTAL_ATTACHMENT_BUDGET);
    });

    it('refuses a 15 MB PDF, which could never be sent, and names the limit', () => {
        expect(overPickLimit({ size: 15 * MB, mimeType: 'application/pdf' })).toBe(12);
    });

    it('lets a 15 MB photo through: it is shrunk before it is sent', () => {
        expect(overPickLimit({ size: 15 * MB, mimeType: 'image/jpeg' })).toBeNull();
        expect(overPickLimit({ size: 25 * MB, mimeType: 'image/jpeg' })).toBe(20);
    });

    it('lets a file of unknown size through, for the send to measure', () => {
        expect(overPickLimit({ size: undefined, mimeType: 'application/pdf' })).toBeNull();
    });
});

describe('at send time', () => {
    it('names one file that is too large on its own, without reading it', async () => {
        const big = { name: 'report.pdf', mimeType: 'application/pdf', size: 15 * MB, uri: 'file:///report.pdf' };
        const sent = encodeAttachments([big]);
        await expect(sent).rejects.toBeInstanceOf(AttachmentTooLargeError);
        await expect(sent).rejects.toThrow('report.pdf is too large to send: one message carries at most 12 MB. Try a smaller file.');
        expect(mockBase64).not.toHaveBeenCalled();
    });

    it('names the file, not the combination, when the one over the budget came with others', async () => {
        const small = { name: 'a.txt', mimeType: 'text/plain', size: MB, dataUrl: 'data:text/plain;base64,QQ==' };
        const big = { name: 'scan.pdf', mimeType: 'application/pdf', size: 13 * MB, dataUrl: 'data:application/pdf;base64,QQ==' };
        await expect(encodeAttachments([small, big])).rejects.toThrow('scan.pdf is too large to send');
    });

    it('says "together" only when several files that each fit do not fit at once', async () => {
        const half = (name: string) => ({ name, mimeType: 'application/pdf', size: 7 * MB, dataUrl: 'data:application/pdf;base64,QQ==' });
        const sent = encodeAttachments([half('a.pdf'), half('b.pdf')]);
        await expect(sent).rejects.toBeInstanceOf(AttachmentBudgetError);
        await expect(sent).rejects.toThrow(
            'Together these files are larger than the 12 MB one message can carry. Send them in separate messages.',
        );
    });

    it('encodes files that fit into data URLs', async () => {
        const [one] = await encodeAttachments([{ name: 'note.txt', mimeType: 'text/plain', size: 3, uri: 'file:///note.txt' }]);
        expect(one?.dataUrl).toBe('data:text/plain;base64,QUJD');
        expect(one?.size).toBe(3);
    });

    it('says which file has nothing to read', async () => {
        await expect(encodeAttachments([{ name: 'ghost.pdf' }])).rejects.toThrow('ghost.pdf has no file to read.');
    });
});
