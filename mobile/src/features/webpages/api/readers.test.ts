/** The webpage readers: the owner verdict, the shown-once link, and the publish answer. */

import { readCreatedShare, readPublished, readWebpageDetail, readWebpageShares } from './readers';

describe('readWebpageDetail', () => {
    it('reads the page and treats only an exact true as read-only', () => {
        const detail = readWebpageDetail({ webpage: { id: 'wp1', name: 'Launch' }, readOnly: 'true', sources: [] });
        expect(detail?.webpage.name).toBe('Launch');
        expect(detail?.readOnly).toBe(false);
        expect(readWebpageDetail({ webpage: { id: 'wp1' }, readOnly: true })?.readOnly).toBe(true);
    });

    it('is null without a page row', () => {
        expect(readWebpageDetail({ readOnly: true })).toBeNull();
        expect(readWebpageDetail(null)).toBeNull();
    });
});

describe('readWebpageShares and readCreatedShare', () => {
    it('keeps a null url as null — the address is gone, not missing', () => {
        const [share] = readWebpageShares({ shares: [{ id: 'sh1', url: null, accessMode: 'password' }] });
        expect(share?.url).toBeNull();
        expect(share?.accessMode).toBe('password');
        // Stripped for anyone but the creator: absent, not null.
        expect(share?.allowedEmails).toBeUndefined();
    });

    it('needs both the share and its url to call a link created', () => {
        expect(readCreatedShare({ share: { id: 'sh1' }, url: 'https://x/share/t' })?.url).toBe('https://x/share/t');
        expect(readCreatedShare({ share: { id: 'sh1' } })).toBeNull();
        expect(readCreatedShare({ url: 'https://x' })).toBeNull();
    });
});

describe('readPublished', () => {
    it('reads the settled state, falling back to what was asked', () => {
        expect(readPublished({ isPublished: false }, true)).toBe(false);
        expect(readPublished(null, true)).toBe(true);
    });
});
