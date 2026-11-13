import { describe, it, expect } from 'vitest';
import { emptyImageRow, rowsFromConfig, rowsSignature, rowsToConfig } from './azureImageRows';
import type { AzureImageRow } from './azureImageRows';

const row = (deployment: string, model = '', price = ''): AzureImageRow => ({ key: deployment, deployment, model, price });

describe('Azure image deployment rows', () => {
    it('reads the stored list, prices included', () => {
        const rows = rowsFromConfig([
            { deployment: 'img-prod', model: 'gpt-image-1.5', pricePerImage: 0.04 },
            { deployment: 'mai', model: 'MAI-Image-2.6', pricePerImage: null },
            { deployment: '' },
            'junk',
        ]);
        expect(rows.map(r => [r.deployment, r.model, r.price])).toEqual([
            ['img-prod', 'gpt-image-1.5', '0.04'],
            ['mai', 'MAI-Image-2.6', ''],
        ]);
        expect(rowsFromConfig(undefined)).toEqual([]);
    });

    it('sends the rows with a deployment name, an empty price as null', () => {
        expect(rowsToConfig([row(' img-prod ', 'gpt-image-1', '0,05'), row('mai', '', ''), emptyImageRow()])).toEqual({
            ok: true,
            value: [
                { deployment: 'img-prod', model: 'gpt-image-1', pricePerImage: 0.05 },
                { deployment: 'mai', pricePerImage: null },
            ],
        });
    });

    it('refuses a price that is not a number from 0 to 1000', () => {
        expect(rowsToConfig([row('a', '', '-1')])).toEqual({ ok: false, reason: 'price' });
        expect(rowsToConfig([row('a', '', 'free')])).toEqual({ ok: false, reason: 'price' });
        expect(rowsToConfig([row('a', '', '1001')])).toEqual({ ok: false, reason: 'price' });
    });

    it('refuses more than 20 deployments', () => {
        const rows = Array.from({ length: 21 }, (_, i) => row(`d${i}`));
        expect(rowsToConfig(rows)).toEqual({ ok: false, reason: 'too_many' });
    });

    it('tells an edit apart from the stored list, ignoring the React keys', () => {
        const stored = rowsFromConfig([{ deployment: 'a', model: 'gpt-image-1', pricePerImage: 0.1 }]);
        const again = rowsFromConfig([{ deployment: 'a', model: 'gpt-image-1', pricePerImage: 0.1 }]);
        expect(rowsSignature(again)).toBe(rowsSignature(stored));
        expect(rowsSignature([{ ...stored[0], price: '0.2' }])).not.toBe(rowsSignature(stored));
    });
});
