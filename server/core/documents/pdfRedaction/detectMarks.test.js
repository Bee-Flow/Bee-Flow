'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { textReason, deriveTerms, detectMarks, norm } = require('./detectMarks');

test('contact details are recognised; article numbers, dates and dimensions are not', () => {
    for (const t of ['www.example-metal.com', 'info@example.nl', 'phone: [+31] 10 123 4567', '+31 6 1234 5678', '010-123 4567', 'NL91 ABNA 0417 1643 00']) {
        assert.equal(textReason(t, []), 'contact', t);
    }
    for (const t of ['00000002', '03-02-2025', '14-07-2026', '2023.0457', 'E00123456', 'R0,5 (2x)', '45°', 'ISO 2768-mK', 'Ø 15', '051234']) {
        assert.equal(textReason(t, []), null, t);
    }
});

test('a long hostile run is tested in linear time, and the bounds lose no real address', () => {
    // Unbounded repetition took ~17 s on 200,000 of these characters; linear takes milliseconds.
    for (const unit of ['a-', 'a.', 'a', 'www.a.1', 'a@a-', '.1']) {
        const run = unit.repeat(Math.ceil(200_000 / unit.length));
        const started = Date.now();
        textReason(run, []);
        deriveTerms([run]);
        assert.ok(Date.now() - started < 2000, `${unit}: ${Date.now() - started} ms`);
    }
    // The bounds are the real limits, and a longer local part still ends in a match.
    assert.equal(textReason(`${'x'.repeat(100)}@mail.acme-metal.co.uk`, []), 'contact');
    assert.equal(textReason(`https://${'sub.'.repeat(40)}acme-metal.com/x`, []), 'contact');
});

test('the customer name is learned from its own web and mail domains, generic ones excluded', () => {
    assert.deepEqual(deriveTerms(['www.acme-metal.com', 'mail: jan@acme-metal.nl', 'x@gmail.com']), ['acme-metal']);
    assert.equal(textReason('Property of Royal Acme Metal BV.', [norm('acme-metal')]), 'company');
});

// A tiny page model: text runs with bboxes in PDF space (y up), sizes in points.
function page(objects) {
    return { box: [0, 0, 595, 842], objects: objects.map((o, id) => ({ id, removable: true, size: 8, ...o })) };
}
const text = (t, x, y, w = 30, size = 8) => ({ kind: 'text', text: t, bbox: [x, y, x + w, y + size], size });

test('the value right of an Author/Checked label is a person; an empty field takes nothing', () => {
    const p = page([
        text('Author', 440, 160, 24), text('JDO', 470, 160, 15), text('Date', 540, 160, 16), text('14-07-2026', 560, 160),
        text('Checked', 440, 140, 27), text('Date', 540, 140, 16), text('21-07-2026', 560, 140),
    ]);
    const { marks } = detectMarks(p, { terms: [] });
    assert.deepEqual(marks.map((m) => m.text), ['JDO']);
});

test('a disclaimer paragraph goes whole, but not the grid label or placeholder under it', () => {
    const p = page([
        text('www.acme-metal.com', 20, 60, 40, 6),
        text('Unless stated otherwise: dimensions in mm, all', 20, 50, 150, 6),
        text('rights reserved. Property of Acme Metal BV.', 20, 43, 150, 6),
        text('use of this document is illegal.', 20, 36, 100, 6),
        text('4', 80, 30, 4, 6),
        text('-', 60, 31, 3, 6),
    ]);
    const { marks } = detectMarks(p, { terms: [norm('acme-metal')] });
    assert.deepEqual(marks.map((m) => m.text).sort(), [
        'Unless stated otherwise: dimensions in mm, all',
        'rights reserved. Property of Acme Metal BV.',
        'use of this document is illegal.',
        'www.acme-metal.com',
    ]);
});

test('coloured or dense artwork next to the company text is a logo; the page frame is not', () => {
    const p = page([
        text('www.acme-metal.com    phone: +31 10 123 4567', 20, 40, 160, 6), // spans the logo cell
        { kind: 'path', bbox: [22, 50, 90, 70], fill: [0, 150, 148], stroke: null, segments: 12 }, // teal logo
        { kind: 'path', bbox: [95, 50, 178, 70], fill: [0, 0, 0], stroke: null, segments: 120 }, // outline letters
        { kind: 'path', bbox: [0, 0, 595, 842], fill: null, stroke: [0, 0, 0], segments: 47 }, // frame
        { kind: 'path', bbox: [400, 700, 450, 720], fill: [0, 150, 148], stroke: null, segments: 30 }, // same brand colour elsewhere
        { kind: 'path', bbox: [300, 300, 310, 310], fill: [0, 0, 0], stroke: null, segments: 30 }, // drawing detail
    ]);
    const { marks } = detectMarks(p, { terms: [] });
    assert.deepEqual(marks.filter((m) => m.category === 'logo').map((m) => m.id).sort(), [1, 2, 4]);
});

test('a mark inside a nested form cannot be cut and is reported as blocked', () => {
    const p = page([{ ...text('www.acme-metal.com', 20, 40, 40, 6), removable: false, form: 'Fm0' }]);
    const { marks, blocked } = detectMarks(p, { terms: [] });
    assert.equal(marks.length, 0);
    assert.equal(blocked.length, 1);
});

test('text runs the AI flagged are marked with its category', () => {
    const p = page([text('Jan de Vries', 100, 400, 50), text('Material', 100, 380)]);
    const { marks } = detectMarks(p, { terms: [], aiMarks: new Map([[0, 'person']]) });
    assert.deepEqual(marks, [{ id: 0, category: 'person', text: 'Jan de Vries' }]);
});
