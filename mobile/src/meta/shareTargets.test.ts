/**
 * Bee Flow has to be in Android's share sheet for ONE shared document, not
 * only for several: sharing a PDF from Drive into a knowledge base is the
 * reason the share target exists. The single-share filter used to name text
 * and media only, so the app appeared for two PDFs but never for one.
 */

import fs from 'fs';
import path from 'path';

const config = fs.readFileSync(path.join(__dirname, '..', '..', 'app.config.ts'), 'utf8');

describe('share targets (app.config.ts → expo-share-intent)', () => {
    const documents = /const SHARED_DOCUMENTS = \[([\s\S]*?)\];/.exec(config)?.[1] ?? '';

    it('lists the documents people share', () => {
        for (const type of ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']) {
            expect(documents).toContain(`'${type}'`);
        }
    });

    it.each(['androidIntentFilters', 'androidMultiIntentFilters'])('%s takes a single document as well as text and media', (key) => {
        const list = new RegExp(`${key}: \\[([^\\]]*)\\]`).exec(config)?.[1] ?? '';
        expect(list).toContain('...SHARED_DOCUMENTS');
        for (const type of ['text/*', 'image/*']) expect(list).toContain(`'${type}'`);
    });
});
