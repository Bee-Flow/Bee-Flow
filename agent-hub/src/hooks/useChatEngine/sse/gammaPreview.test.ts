// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { extractGammaPreview } from './gammaPreview';

describe('extractGammaPreview', () => {
    it('ignores tools that are not gamma_*', () => {
        expect(extractGammaPreview('create_issue', { gammaUrl: 'https://x' })).toBeNull();
        expect(extractGammaPreview(undefined, { gammaUrl: 'https://x' })).toBeNull();
    });

    it('ignores errors, unparseable strings and results without an id or url', () => {
        expect(extractGammaPreview('gamma_generate', { error: 'boom', generationId: 'g1' })).toBeNull();
        expect(extractGammaPreview('gamma_generate', 'not json')).toBeNull();
        expect(extractGammaPreview('gamma_generate', { status: 'pending' })).toBeNull();
        expect(extractGammaPreview('gamma_generate', null)).toBeNull();
    });

    it('reads a pending generation from a JSON string', () => {
        expect(extractGammaPreview('gamma_generate', JSON.stringify({ generationId: 'g1' }))).toEqual({
            generationId: 'g1',
            status: 'pending',
            gammaId: null,
            gammaUrl: null,
            exportUrl: null,
            templateGammaId: null,
            templateUrl: null,
            sourceTool: 'gamma_generate',
        });
    });

    it('treats a result with a url as completed unless it says otherwise', () => {
        expect(extractGammaPreview('gamma_status', { gammaUrl: 'https://g' })?.status).toBe('completed');
        expect(extractGammaPreview('gamma_status', { gammaUrl: 'https://g', status: 'exporting' })?.status).toBe('exporting');
    });
});
