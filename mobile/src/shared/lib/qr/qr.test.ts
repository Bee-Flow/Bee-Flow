/**
 * The QR encoder, pinned to its own output.
 *
 * A QR that is drawn but wrong is worse than none, and nothing on a CI box can
 * scan one — so the matrices below are fingerprints of what this encoder drew
 * before it was split into modules, across every version boundary the
 * otpauth screen can reach. Any change to the output is a change to what
 * phones scan, and has to be made on purpose.
 */

import { createHash } from 'node:crypto';

import { encodeQr, type QrMatrix } from './index';

function fingerprint(matrix: QrMatrix | null): [number, string] | null {
    if (!matrix) return null;
    const bits = matrix.modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join('')).join('\n');
    return [matrix.size, createHash('sha256').update(bits).digest('hex').slice(0, 16)];
}

const OTPAUTH = 'otpauth://totp/Bee%20Flow:ada%40example.nl?secret=JBSWY3DPEHPK3PXP&issuer=Bee%20Flow';

const GOLDEN: [string, [number, string] | null][] = [
    ['', [21, 'c30ac51df3031a0d']],
    ['A', [21, '177b3a1897a152ae']],
    [OTPAUTH, [37, '340c7ac861f112f7']],
    ['x'.repeat(100), [41, '57004a2bb3595724']],
    ['ü€漢字'.repeat(10), [45, 'a89cfc2014744cee']],
    ['y'.repeat(213), [57, '3bb4dc258df63cd7']],
    ['y'.repeat(214), null],
    ['z'.repeat(150), [49, 'dc814b4d22965968']],
    ['q'.repeat(60), [33, '1d1dfca99ef3fedd']],
];

describe('encodeQr', () => {
    it.each(GOLDEN.map(([input, expected], i) => [i, input, expected] as const))(
        'draws case %i exactly as before',
        (_i, input, expected) => {
            expect(fingerprint(encodeQr(input))).toEqual(expected);
        },
    );

    it('answers null past version 10 rather than drawing something wrong', () => {
        expect(encodeQr('y'.repeat(214))).toBeNull();
    });

    it('puts a finder pattern in three corners', () => {
        const qr = encodeQr(OTPAUTH);
        expect(qr).not.toBeNull();
        const { size, modules } = qr as QrMatrix;
        const dark = (x: number, y: number) => modules[y]?.[x] === true;
        for (const [cx, cy] of [
            [3, 3],
            [size - 4, 3],
            [3, size - 4],
        ] as const) {
            expect(dark(cx, cy)).toBe(true); // centre of the 3x3 core
            expect(dark(cx - 2, cy)).toBe(false); // the light ring
            expect(dark(cx - 3, cy)).toBe(true); // the dark outer ring
        }
    });
});
