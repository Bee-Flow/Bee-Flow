/**
 * The voice turn's hand-built multipart body. multer rejects a part whose
 * type is not `audio/*`, and parses `history` with JSON.parse — so the exact
 * bytes are the contract.
 */

import { buildMultipart, field } from './multipart';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('buildMultipart', () => {
    it('writes each field and the file with our boundary and our content type', () => {
        const audio = new TextEncoder().encode('AUDIO');
        const { bytes, contentType } = buildMultipart(
            [
                field('history', '[]'),
                { kind: 'file', name: 'audio', filename: 'turn.m4a', contentType: 'audio/mp4', bytes: audio },
            ],
            'XYZ',
        );
        expect(contentType).toBe('multipart/form-data; boundary=XYZ');
        expect(decode(bytes)).toBe(
            '--XYZ\r\nContent-Disposition: form-data; name="history"\r\n\r\n[]\r\n' +
                '--XYZ\r\nContent-Disposition: form-data; name="audio"; filename="turn.m4a"\r\n' +
                'Content-Type: audio/mp4\r\n\r\nAUDIO\r\n' +
                '--XYZ--\r\n',
        );
    });

    it('draws a fresh boundary when none is given', () => {
        const a = buildMultipart([field('a', '1')]).contentType;
        const b = buildMultipart([field('a', '1')]).contentType;
        expect(a).toMatch(/^multipart\/form-data; boundary=----BeeFlowVoice[a-z0-9]+$/);
        expect(a).not.toBe(b);
    });
});
