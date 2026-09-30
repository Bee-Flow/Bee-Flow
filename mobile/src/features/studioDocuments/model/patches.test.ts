import { applyPreset, clampNumber, isHexColour, presetOf, setDesignValue } from './design';
import {
    addSectionPatch,
    contractPatch,
    designOf,
    designPatch,
    houseStylePatch,
    newSectionId,
    sampleValuesOf,
    sectionOverridesOf,
    usesHouseStyle,
    valuesPatch,
} from './patches';
import type { StudioDocument } from './types';

const DOC: StudioDocument = {
    id: 'd1',
    name: 'Invoice',
    docType: 'invoice',
    description: '',
    kind: 'document',
    visibility: 'private',
    categories: [],
    versionId: 'v1',
    htmlSize: 10,
    updatedAt: null,
    bodyHtml: '<h1>Invoice</h1>',
    css: '',
    settings: { design: { preset: 'formal' }, sampleValues: { total: 5 }, sectionOverrides: { remote: 'include' }, deck: {}, resolvedHouseStyleCss: 'x' },
    editable: true,
    contract: { instructions: '', parameters: [], sections: [{ id: 'overview', title: 'Overview', summary: '', condition: null }] },
};

describe('reading settings', () => {
    it('finds the values, the choices, the design and the house-style switch', () => {
        expect(sampleValuesOf(DOC)).toEqual({ total: 5 });
        expect(sectionOverridesOf(DOC)).toEqual({ remote: 'include' });
        expect(designOf(DOC)).toEqual({ preset: 'formal' });
        expect(usesHouseStyle(DOC)).toBe(true);
        expect(usesHouseStyle({ settings: { houseStyle: false } })).toBe(false);
        expect(sampleValuesOf({ settings: { sampleValues: [1] } })).toEqual({});
    });
});

describe('patches merge into the current settings', () => {
    it('keeps every settings key a tab does not own', () => {
        const contract = { instructions: 'i', parameters: [], sections: [] };
        expect(contractPatch({ contract, kind: 'template', visibility: 'team' }, DOC)).toEqual({
            settings: { ...DOC.settings, contract },
            kind: 'template',
            visibility: 'team',
        });
        expect(contractPatch({ contract, kind: 'document', visibility: 'team' }, DOC).visibility).toBe('private');
        expect(valuesPatch({ sampleValues: { a: 1 }, sectionOverrides: {} }, DOC).settings).toEqual({ ...DOC.settings, sampleValues: { a: 1 }, sectionOverrides: {} });
        expect(designPatch({ preset: 'neutral' }, DOC).settings?.design).toEqual({ preset: 'neutral' });
        expect(houseStylePatch(false, DOC).settings).toEqual({ ...DOC.settings, houseStyle: false });
        expect(houseStylePatch(true, undefined).settings).toEqual({ houseStyle: true });
    });

    it('declares a new section and appends it to the body in one save', () => {
        const patch = addSectionPatch({ id: 'section-1', title: 'Terms & conditions', body: 'Write <here>.' }, DOC);
        expect(patch.bodyHtml).toBe('<h1>Invoice</h1><section data-doc-section="section-1"><h2>Terms &amp; conditions</h2><p>Write &lt;here&gt;.</p></section>');
        expect((patch.settings?.contract as StudioDocument['contract']).sections.map((s) => s.id)).toEqual(['overview', 'section-1']);
    });

    it('mints section ids the server accepts', () => {
        expect(newSectionId(() => 0)).toBe('section-00000000');
        expect(newSectionId()).toMatch(/^section-[0-9a-z]{8}$/);
    });
});

describe('design', () => {
    it('applies presets and fills unset values from the neutral one', () => {
        expect(applyPreset('formal')).toMatchObject({ preset: 'formal', font: 'serif', margin: 22 });
        expect(setDesignValue({}, 'accent', '#000000')).toMatchObject({ accent: '#000000', ink: '#172033', fontSize: 11 });
        expect([presetOf({ preset: 'branded' }), presetOf({ preset: 'odd' })]).toEqual(['branded', 'neutral']);
    });

    it('checks colours and clamps numbers', () => {
        expect([isHexColour('#abc'), isHexColour('#aabbcc'), isHexColour('red'), isHexColour(3)]).toEqual([true, true, false, false]);
        expect(clampNumber('100', { min: 0, max: 40 })).toBe(40);
        expect(clampNumber('1,5', { min: 1, max: 2.5 })).toBe(1.5);
        expect(clampNumber('', { min: 0, max: 1 })).toBeNull();
        expect(clampNumber('x', { min: 0, max: 1 })).toBeNull();
    });
});
