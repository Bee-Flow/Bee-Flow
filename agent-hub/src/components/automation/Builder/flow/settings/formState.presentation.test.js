// @vitest-environment node
import { expect, it } from 'vitest';
import { extractFormState, buildPatch } from './formState';

/** buildPatch returns only what changed; the saved step is the merge. */
const saved = (step, draft) => ({ ...step, ...buildPatch(step, draft) });

/**
 * The slide's Visual picker is a VIEW over stored fields, and the deck's Look
 * fields travel as a value or absent — never ''. Both directions here.
 */

it('slide: a stored chart opens on "Chart" with its columns; saving writes one nested chart object and clears the other visuals', () => {
    const step = { id: 's', type: 'slide', title: 'Omzet', chart: { type: 'line', data: '{{steps.q.output.rows}}', labels: 'maand', values: 'omzet', stacked: true, unit: '%' }, image: 'x' };
    const draft = extractFormState(step);
    expect(draft.visual).toBe('chart');
    expect(draft.chartType).toBe('line');
    expect(draft.chartData).toBe('{{steps.q.output.rows}}');
    expect(draft.chartLabels).toBe('maand');
    expect(draft.chartStacked).toBe(true);
    expect(draft.chartUnit).toBe('%');
    const patch = buildPatch(step, { ...draft, chartValues: 'omzet, kosten', chartStacked: false });
    expect(patch.chart).toEqual({ type: 'line', data: '{{steps.q.output.rows}}', labels: 'maand', values: 'omzet, kosten', unit: '%' });
    expect(patch.image).toBeUndefined();
    expect(patch.stats).toBeUndefined();
    // Inline JSON rows are kept as rows
    const json = buildPatch(step, { ...draft, chartData: '[{"m":"a","v":1}]', chartLabels: '', chartValues: '', chartUnit: '' });
    expect(json.chart).toEqual({ type: 'line', data: [{ m: 'a', v: 1 }], stacked: true });
});

it('slide: stats / image / timeline / none each keep only their own field; style is absent unless chosen', () => {
    const step = { id: 's', type: 'slide', title: 'T', stats: 'a | b', style: 'accent' };
    const draft = extractFormState(step);
    expect(draft.visual).toBe('stats');
    expect(draft.style).toBe('accent');
    const same = saved(step, draft);
    expect(same).toMatchObject({ stats: 'a | b', style: 'accent' });
    expect(same.chart).toBeUndefined();
    expect(same.image).toBeUndefined();
    expect(saved(step, { ...draft, visual: 'image', image: '{{steps.i.output.imageUrl}}' })).toMatchObject({ image: '{{steps.i.output.imageUrl}}', stats: undefined });
    expect(saved(step, { ...draft, visual: 'timeline', style: '' })).toMatchObject({ layout: 'timeline', stats: undefined, style: undefined });
    expect(saved({ ...step, layout: 'timeline' }, { ...draft, visual: 'none', layout: 'timeline' })).toMatchObject({ layout: undefined, stats: undefined });
    expect(extractFormState({ id: 's', type: 'slide', layout: 'timeline' }).visual).toBe('timeline');
    expect(extractFormState({ id: 's', type: 'slide', image: 'x' }).visual).toBe('image');
    expect(extractFormState({ id: 's', type: 'slide', stats: [{ value: '1', label: 'a' }] }).stats).toBe('{"value":"1","label":"a"}');
});

it('presentation: the look fields round-trip; blanks are absent; slide numbers are three-state', () => {
    const step = { id: 'd', type: 'presentation', slides: 'x', logo: 'none', logoPlacement: 'corner', background: '#16191F', footerText: 'F', titleFont: 'Georgia', slideNumbers: false };
    const draft = extractFormState(step);
    expect(draft).toMatchObject({ logo: 'none', logoPlacement: 'corner', background: '#16191F', footerText: 'F', titleFont: 'Georgia', slideNumbers: 'false' });
    expect(saved(step, draft)).toMatchObject({ logo: 'none', logoPlacement: 'corner', background: '#16191F', footerText: 'F', titleFont: 'Georgia', slideNumbers: false });
    const cleared = saved(step, { ...draft, logo: '', logoPlacement: '', background: ' ', footerText: '', titleFont: '', slideNumbers: '' });
    for (const k of ['logo', 'logoPlacement', 'background', 'footerText', 'titleFont', 'slideNumbers']) expect(cleared[k]).toBeUndefined();
    expect(saved(step, { ...draft, slideNumbers: 'true' }).slideNumbers).toBe(true);
    expect(extractFormState({ id: 'd', type: 'presentation', slides: 'x' }).slideNumbers).toBe('');
});

it('presentation: saveCopy/copyName round-trip and are absent when off; fill_document: format only for a presentation document', () => {
    const step = { id: 'd', type: 'presentation', slides: '{{steps.w.output.text}}', saveCopy: true, copyName: 'Deck {{trigger.date}}' };
    const draft = extractFormState(step);
    expect(draft.saveCopy).toBe(true);
    expect(draft.copyName).toBe('Deck {{trigger.date}}');
    const off = saved(step, { ...draft, saveCopy: false });
    expect(off.saveCopy).toBeUndefined();
    expect(off.copyName).toBeUndefined();
    const on = saved({ id: 'd', type: 'presentation', slides: 'x' }, { ...extractFormState({ id: 'd', type: 'presentation', slides: 'x' }), saveCopy: true, copyName: '' });
    expect(on.saveCopy).toBe(true);
    expect(on.copyName).toBeUndefined();

    const fill = { id: 'f', type: 'fill_document', documentId: 'deck_1', values: {}, format: 'pdf' };
    const fd = extractFormState(fill);
    expect(fd.format).toBe('pdf');
    expect(saved(fill, { ...fd, format: 'pptx' }).format).toBe('pptx');
    expect(saved(fill, { ...fd, format: '' }).format).toBeUndefined();
    expect(extractFormState({ id: 'f', type: 'fill_document', documentId: 'x' }).format).toBe('');
});
