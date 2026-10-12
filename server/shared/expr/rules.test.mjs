/**
 * The Condition node's rule logic (rules.mjs, fileTypes.mjs, ruleFields.mjs):
 * equals, File type, the quantifiers, the rule-shape text helpers and the
 * field menu both platforms build their rule rows from.
 *
 * Run: node --test shared/expr/rules.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    equalsValue, fileTypeOf, isFileRecord, fileTypesNamedIn, fileTypeField, quantify, elementPasses,
    fieldShape, quantifiedCall, readQuantifiedCall, splitTopLevel, splitCallArgs, findTopLevelSymbol,
    singularKey, ruleFieldOptions, FILE_TYPE_KEYS, TEST_OF_OP, OP_OF_TEST, UNARY_TESTS, QUANTIFIER_FN,
    textContains, textStartsWith, textEndsWith, isEmptyValue,
} from './rules.mjs';
import { appendKey, appendWildcard } from './path.mjs';
import { evaluate, FUNCTIONS } from './engine.mjs';

test('equalsValue: text ignores case and spaces, "5" equals 5, lists and records compare by content', () => {
    const cases = [
        ['Open ', 'open', true],
        [5, '5', true],
        [' 5.0 ', 5, true],
        ['-3', -3, true],
        ['5x', 5, false],
        [[], '', false],
        [null, '', false],
        [null, undefined, true],
        [undefined, undefined, true],
        [0, null, false],
        [true, 'true', true],
        [true, 1, false],
        ['a,b', ['a', 'b'], false],
        [['A', 'b'], ['a', 'B '], true],
        [['a'], ['a', 'b'], false],
        [{ a: 1, b: [2] }, { b: [2], a: 1 }, true],
        [{ a: 1 }, { a: 2 }, false],
        [{ a: 1 }, '{"a":1}', false],
        [new Date(0), new Date(0), false],
        [Number.NaN, Number.NaN, false],
        ['Contoso', 'contoso facilitair', false],
        ['007', '7', false],
        ['0612345678', '612345678', false],
        ['1.50', '1.5', false],
        ['1234567890123456789', '1234567890123456788', false],
        ['007', '007', true],
        ['0.5', 0.5, true],
        [7, '007', true],
    ];
    for (const [a, b, want] of cases) {
        assert.equal(equalsValue(a, b), want, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
        assert.equal(equalsValue(b, a), want, `symmetric: ${JSON.stringify(b)} vs ${JSON.stringify(a)}`);
    }
});

test('the scalar text tests are the bodies of contains/startsWith/endsWith/isEmpty', () => {
    const samples = [null, undefined, '', 'Hello World', 42, true, [], ['a'], {}, { a: 1 }];
    const parts = ['', 'hello', 'WORLD', '4', null];
    for (const a of samples) {
        assert.equal(FUNCTIONS.isEmpty(a), isEmptyValue(a));
        for (const b of parts) {
            assert.equal(FUNCTIONS.startsWith(a, b), textStartsWith(a, b));
            assert.equal(FUNCTIONS.endsWith(a, b), textEndsWith(a, b));
            if (!Array.isArray(a)) assert.equal(FUNCTIONS.contains(a, b), textContains(a, b));
        }
    }
    // contains keeps its list branch: an exact element, or a text element containing the part.
    assert.equal(FUNCTIONS.contains(['Not urgent', 'x'], 'urgent'), true);
    assert.equal(FUNCTIONS.contains([5, 6], '5'), false);
});

test('fileTypeOf: every row of the table, by MIME and by extension', () => {
    const rows = {
        pdf: { mimes: ['application/pdf', 'application/x-pdf'], names: ['a.pdf'] },
        word: {
            mimes: ['application/msword', 'application/rtf', 'text/rtf', 'application/vnd.oasis.opendocument.text',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-word.document.macroEnabled.12'],
            names: ['a.doc', 'a.docx', 'a.docm', 'a.dot', 'a.dotx', 'a.odt', 'a.rtf'],
        },
        excel: {
            mimes: ['application/vnd.ms-excel', 'text/csv', 'application/csv', 'application/vnd.oasis.opendocument.spreadsheet',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
            names: ['a.xls', 'a.xlsx', 'a.xlsm', 'a.ods', 'a.csv'],
        },
        powerpoint: {
            mimes: ['application/vnd.ms-powerpoint', 'application/vnd.oasis.opendocument.presentation',
                'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
            names: ['a.ppt', 'a.pptx', 'a.pps', 'a.ppsx', 'a.odp', 'a.key'],
        },
        image: { mimes: ['image/png', 'image/jpeg', 'image/svg+xml'], names: ['a.jpg', 'a.jpeg', 'a.png', 'a.gif', 'a.webp', 'a.heic', 'a.heif', 'a.bmp', 'a.tif', 'a.tiff', 'a.svg'] },
        text: { mimes: ['application/json', 'application/xml', 'text/plain', 'text/html', 'text/markdown'], names: ['a.txt', 'a.md', 'a.log', 'a.json', 'a.xml', 'a.html', 'a.htm'] },
        archive: {
            mimes: ['application/zip', 'application/x-zip-compressed', 'application/x-7z-compressed', 'application/x-rar-compressed',
                'application/vnd.rar', 'application/gzip', 'application/x-gzip', 'application/x-tar'],
            names: ['a.zip', 'a.7z', 'a.rar', 'a.gz', 'a.tgz', 'a.tar'],
        },
        audio: { mimes: ['audio/mpeg', 'audio/wav'], names: ['a.mp3', 'a.wav', 'a.m4a', 'a.ogg', 'a.flac', 'a.aac'] },
        video: { mimes: ['video/mp4', 'video/quicktime'], names: ['a.mp4', 'a.mov', 'a.mkv', 'a.avi', 'a.webm'] },
    };
    for (const [key, { mimes, names }] of Object.entries(rows)) {
        for (const m of mimes) {
            assert.equal(fileTypeOf(m), key, m);
            assert.equal(fileTypeOf({ mimeType: m }), key, `record ${m}`);
        }
        for (const n of names) {
            assert.equal(fileTypeOf(n), key, n);
            assert.equal(fileTypeOf({ filename: n, mimeType: 'application/octet-stream' }), key, `octet-stream ${n}`);
        }
    }
    assert.deepEqual(Object.keys(rows).concat('other'), [...FILE_TYPE_KEYS]);
});

test('fileTypeOf: generic MIME falls back to the name, case and parameters do not matter', () => {
    assert.equal(fileTypeOf({ filename: 'a.PPTX', mimeType: 'application/octet-stream' }), 'powerpoint');
    for (const generic of ['binary/octet-stream', 'application/x-download', 'application/download', 'application/force-download', 'application/unknown', '']) {
        assert.equal(fileTypeOf({ name: 'Tarieven.xlsx', contentType: generic }), 'excel', generic);
    }
    assert.equal(fileTypeOf('Application/PDF; name="x.pdf"'), 'pdf');
    assert.equal(fileTypeOf('text/plain; charset=utf-8'), 'text');
    assert.equal(fileTypeOf('text/csv;charset=UTF-8'), 'excel', 'the exact list wins over the text/ prefix');
    // The MIME wins over the name when it says something.
    assert.equal(fileTypeOf({ filename: 'scan.pdf', mimeType: 'image/jpeg' }), 'image');
    // Unknown, or only a name without a known extension: other. Nothing to read: null.
    assert.equal(fileTypeOf({ mimeType: 'application/x-foo' }), 'other');
    assert.equal(fileTypeOf({ filename: 'notes' }), 'other');
    assert.equal(fileTypeOf({ size: 12 }), null);
    assert.equal(fileTypeOf('application/x-foo'), 'other');
    assert.equal(fileTypeOf('docs/report.pdf'), 'pdf');
    assert.equal(fileTypeOf('C:\\files\\a.v2\\notes'), 'other');
});

test('fileTypeOf: every record key variant, lists mapped, nothing is null', () => {
    for (const k of ['mimeType', 'mime_type', 'mimetype', 'contentType', 'content_type', 'mediaType']) {
        assert.equal(fileTypeOf({ [k]: 'application/pdf' }), 'pdf', k);
    }
    assert.equal(fileTypeOf({ type: 'application/pdf' }), 'pdf', '`type` counts when it holds a MIME');
    assert.equal(fileTypeOf({ type: 'invoice', name: 'a.docx' }), 'word', '`type` without a slash is not a MIME');
    for (const k of ['filename', 'fileName', 'file_name', 'name', 'originalName', 'title', 'path']) {
        assert.equal(fileTypeOf({ [k]: 'x.zip' }), 'archive', k);
    }
    assert.deepEqual(fileTypeOf(['a.pdf', { mimeType: 'image/png' }, null, 7]), ['pdf', 'image', null, null]);
    assert.equal(fileTypeOf(null), null);
    assert.equal(fileTypeOf(undefined), null);
    assert.equal(fileTypeOf(42), null);
    // The engine function is this helper.
    assert.equal(evaluate('fileType(item)', { item: { filename: 'a.PPTX' } }), 'powerpoint');
});

test('isFileRecord: a MIME type, or a name with a known extension', () => {
    assert.equal(isFileRecord({ mimeType: 'application/pdf' }), true);
    assert.equal(isFileRecord({ mimeType: 'application/octet-stream', filename: 'x' }), true, 'any MIME-shaped text');
    assert.equal(isFileRecord({ filename: 'a.docx' }), true);
    assert.equal(isFileRecord({ name: 'Fabrikam Tankpas' }), false);
    assert.equal(isFileRecord({ subject: 'Factuur', from: 'a@fabrikam.example' }), false);
    assert.equal(isFileRecord({ mimeType: 'not a mime' }), false);
    assert.equal(isFileRecord(['a.pdf']), false);
    assert.equal(isFileRecord('a.pdf'), false);
    assert.equal(isFileRecord(null), false);
});

test('fileTypesNamedIn: the types a sentence names, in order, on word boundaries', () => {
    assert.deepEqual(fileTypesNamedIn('split these files by pdf, word and powerpoint').map((t) => t.key), ['pdf', 'word', 'powerpoint']);
    assert.deepEqual(fileTypesNamedIn('Slides first, then PDFs').map((t) => [t.key, t.word]), [['powerpoint', 'slides'], ['pdf', 'pdfs']]);
    assert.deepEqual(fileTypesNamedIn('csv or excel').map((t) => [t.key, t.word]), [['excel', 'csv']], 'one entry per type, its earliest word');
    assert.deepEqual(fileTypesNamedIn('a document about wordpress'), [], '"document" is not "doc", "wordpress" is not "word"');
    assert.deepEqual(fileTypesNamedIn('photos.zip'), [{ key: 'image', word: 'photos', at: 0 }, { key: 'archive', word: 'zip', at: 7 }]);
    assert.deepEqual(fileTypesNamedIn(null), []);
});

test('fileTypeField writes the File type pseudo field', () => {
    assert.equal(fileTypeField('item'), 'fileType(item)');
    assert.equal(fileTypeField('item.attachments', { list: true }), 'fileType(item.attachments[*])');
});

test('quantify: any, every, none — empty lists, JSON text, a single value, unknown tests', () => {
    const tags = ['Urgent', 'billing'];
    assert.equal(quantify('any', tags, 'equals', 'urgent'), true);
    assert.equal(quantify('every', tags, 'equals', 'urgent'), false);
    assert.equal(quantify('none', tags, 'equals', 'spam'), true);
    assert.equal(quantify('any', [], 'equals', 'x'), false);
    assert.equal(quantify('every', [], 'equals', 'x'), false, 'every needs at least one entry');
    assert.equal(quantify('none', [], 'equals', 'x'), true);
    assert.equal(quantify('any', null, 'isEmpty'), false);
    assert.equal(quantify('none', undefined, 'isEmpty'), true);
    assert.equal(quantify('any', '["a.pdf","b.png"]', 'endsWith', '.PDF'), true, 'a list held as JSON text');
    assert.equal(quantify('any', 'report.pdf', 'endsWith', '.pdf'), true, 'one value is a list of one');
    assert.equal(quantify('every', [3, 5], '>', 2), true);
    assert.equal(quantify('every', [3, 1], '>=', 2), false);
    assert.equal(quantify('any', ['', 'x'], 'isEmpty'), true);
    assert.equal(quantify('every', ['', 'x'], '!isEmpty'), false);
    assert.equal(quantify('none', ['open', 'Closed'], '!contains', 'o'), true);
    assert.throws(() => quantify('any', [], 'endswith', '.pdf'), /Unknown test "endswith"/, 'a typo fails even on an empty list');
    assert.throws(() => quantify('some', ['a'], 'equals', 'a'), /Unknown quantifier/);
    assert.throws(() => elementPasses('a', 'toString', 'a'), /Unknown test/);
    assert.equal(elementPasses('5', '==', 5), true, '== is the engine\'s loose equality');
    assert.equal(elementPasses('A', '!=', 'a'), true);
});

test('fieldShape: plain, column, file of the item, files of a list — and what is none of them', () => {
    assert.deepEqual(fieldShape('item.subject'), { kind: 'plain', path: 'item.subject' });
    assert.deepEqual(fieldShape(' item["Story Points"] '), { kind: 'plain', path: 'item["Story Points"]' });
    assert.deepEqual(fieldShape('item.attachments[*].mimeType'), { kind: 'column', path: 'item.attachments[*].mimeType', list: 'item.attachments', column: 'mimeType' });
    assert.deepEqual(fieldShape('item.lines[*].from.email'), { kind: 'column', path: 'item.lines[*].from.email', list: 'item.lines', column: 'from.email' });
    assert.deepEqual(fieldShape('fileType(item)'), { kind: 'fileRecord', path: 'fileType(item)', record: 'item' });
    assert.deepEqual(fieldShape('fileType(item.file)'), { kind: 'fileRecord', path: 'fileType(item.file)', record: 'item.file' });
    assert.deepEqual(fieldShape('fileType(item.attachments[*])'), { kind: 'fileList', path: 'fileType(item.attachments[*])', list: 'item.attachments' });
    for (const bad of ['item.a[*].b[*].c', '[*].x', 'item.attachments[*]', 'fileType(a[*].b)', 'fileType(a[*][*])', 'fileType([*])',
        'contains(item.a, "x")', 'item.a + 1', '"text"', '5', 'true', '', null, 'fileType(item) && fileType(x)']) {
        assert.equal(fieldShape(bad), null, String(bad));
    }
});

test('quantifiedCall and readQuantifiedCall round-trip, unary tests included', () => {
    const rows = [
        ['any', 'item.attachments[*].filename', 'endsWith', '".pdf"'],
        ['every', 'item.lines[*].qty', 'gt', '0'],
        ['none', 'item.labels[*].name', 'is', '"spam"'],
        ['any', 'fileType(item.attachments[*])', 'is', '"pdf"'],
        ['any', 'item.a[*].b', 'isNot', '"x, y"'],
        ['none', 'item.a[*].b', 'notContains', 'steps.s1.output.word'],
        ['every', 'item.a[*].b', 'isNotEmpty', null],
        ['any', 'item.a[*].b', 'isEmpty', null],
    ];
    for (const [quantifier, left, op, rhs] of rows) {
        const text = quantifiedCall(quantifier, left, op, rhs);
        assert.ok(text.startsWith(`${QUANTIFIER_FN[quantifier]}(${left}, "${TEST_OF_OP[op]}"`), text);
        assert.deepEqual(readQuantifiedCall(text), { quantifier, left, op, rhs }, text);
        assert.doesNotThrow(() => evaluate(text, { item: {}, steps: {} }), text);
    }
    assert.equal(quantifiedCall('some', 'a', 'is', '"x"'), '');
    assert.equal(quantifiedCall('any', 'a', 'isAbout', '"x"'), '');
    assert.deepEqual(readQuantifiedCall("anyOf(item.a[*].b, 'endsWith', '.pdf')"), { quantifier: 'any', left: 'item.a[*].b', op: 'endsWith', rhs: "'.pdf'" });
    assert.deepEqual(readQuantifiedCall('noneOf(item.x[*], "!isEmpty")'), { quantifier: 'none', left: 'item.x[*]', op: 'isNotEmpty', rhs: null });
    for (const bad of [
        '!anyOf(item.a[*].b, "equals", "x")',      // "no" says that
        'anyOf(item.a[*].b, "equals", "x") + 1',   // the call does not end the fragment
        'anyOf(item.a[*].b, "endswith", ".pdf")',  // unknown test
        'anyOf(item.a[*].b, "isEmpty", 1)',        // unary test with a value
        'anyOf(item.a[*].b, "equals")',            // binary test without one
        'anyOf(item.a[*].b, item.t, "x")',         // the test is not a literal
        'anyOf(item.a[*].b, "equ\\"als", "x")',
        'someOf(item.a, "equals", "x")',
        'anyOf(item.a, "equals", "x"',
    ]) {
        assert.equal(readQuantifiedCall(bad), null, bad);
    }
    assert.deepEqual(Object.keys(OP_OF_TEST).sort(), Object.values(TEST_OF_OP).sort());
    assert.deepEqual([...UNARY_TESTS], ['isEmpty', '!isEmpty']);
});

test('the split helpers: top-level joins, call arguments, symbols outside strings and brackets', () => {
    assert.deepEqual(splitTopLevel('steps.a.output.x == 1 && contains(item.name, ".pdf")'), { parts: ['steps.a.output.x == 1', 'contains(item.name, ".pdf")'], join: '&&' });
    assert.deepEqual(splitTopLevel('item.a == 1 || item.b == 2'), { parts: ['item.a == 1', 'item.b == 2'], join: '||' });
    assert.equal(splitTopLevel('a == 1 && b == 2 || c == 3'), null, 'mixed joiners');
    assert.deepEqual(splitTopLevel('contains(item.s, "a && b") && (x || y)'), { parts: ['contains(item.s, "a && b")', '(x || y)'], join: '&&' });
    assert.equal(splitTopLevel('contains(item.s, "x'), null, 'unbalanced');
    assert.deepEqual(splitTopLevel('item.a'), { parts: ['item.a'], join: '&&' });

    const text = 'contains(item.headers[name="a,b"].value, "x, y") && z';
    assert.deepEqual(splitCallArgs(text, 'contains('.length), { args: ['item.headers[name="a,b"].value', '"x, y"'], end: text.indexOf(') &&') });
    assert.deepEqual(splitCallArgs('f(a, g(b, c))', 2), { args: ['a', 'g(b, c)'], end: 12 });
    assert.equal(splitCallArgs('f(a, b', 2), null);

    assert.equal(findTopLevelSymbol('item.a == "x == y"', '=='), 7);
    assert.equal(findTopLevelSymbol('f(a == b) != c', '!='), 10);
    assert.equal(findTopLevelSymbol('a["=="]', '=='), -1);
});

test('singularKey: the loop-name rules', () => {
    const cases = { attachments: 'attachment', Attachments: 'Attachment', categories: 'category', boxes: 'box', addresses: 'address',
        matches: 'match', wishes: 'wish', lines: 'line', status: 'status', address: 'address', analysis: 'analysis', as: 'as', item: 'item' };
    for (const [k, want] of Object.entries(cases)) assert.equal(singularKey(k), want, k);
});

// The platforms' field tree (sampleToFields) in miniature: keys, a record's
// children, and the [*] columns of a list of records.
function fieldsOf(value, base) {
    const out = [];
    for (const [key, sample] of Object.entries(value)) {
        const path = appendKey(base, key);
        const f = { key, path, sample };
        if (sample && typeof sample === 'object' && !Array.isArray(sample)) f.children = fieldsOf(sample, path);
        if (Array.isArray(sample) && sample[0] && typeof sample[0] === 'object') f.children = fieldsOf(Object.assign({}, ...sample), appendWildcard(path));
        out.push(f);
    }
    return out;
}

const human = (k) => k.charAt(0).toUpperCase() + k.slice(1).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
const groups = (kind, v) => ({ item: `Fields of each ${v.name}`, inner: `${v.list} of each ${v.name}`, parent: `The ${v.name} it came from` })[kind];

test('ruleFieldOptions on a mail: its fields, Attachments once, then the attachments with File type first', () => {
    const mail = {
        subject: 'Factuur', from: 'Fabrikam <a@fabrikam.example>', meta: { size: 3 },
        attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', size: 4 }, { filename: 'b.png', mimeType: 'image/png', size: 2 }],
    };
    const opts = ruleFieldOptions(fieldsOf(mail, 'item'), { element: mail, name: human, group: groups, itemName: 'message' });
    assert.deepEqual(opts.map((o) => [o.group, o.label, o.path, o.quantified || false, o.kind || null]), [
        ['Fields of each message', 'Subject', 'item.subject', false, null],
        ['Fields of each message', 'From', 'item.from', false, null],
        ['Fields of each message', 'Meta', 'item.meta', false, null],
        ['Fields of each message', 'Meta · Size', 'item.meta.size', false, null],
        ['Fields of each message', 'Attachments', 'item.attachments', false, 'records'],
        ['Attachments of each message', 'File type', 'fileType(item.attachments[*])', true, 'fileType'],
        ['Attachments of each message', 'Filename', 'item.attachments[*].filename', true, null],
        ['Attachments of each message', 'Mime type', 'item.attachments[*].mimeType', true, null],
        ['Attachments of each message', 'Size', 'item.attachments[*].size', true, null],
    ]);
    assert.equal(opts.find((o) => o.kind === 'fileType').sample, 'pdf');
    assert.ok(!opts.some((o) => o.group.startsWith('Fields') && o.path.includes('[*]')), 'no list column in the item group');
});

test('ruleFieldOptions on an attachment: File type first; a JSON-text list of records counts as records', () => {
    const att = { filename: 'Tarieven.PPTX', mimeType: 'application/octet-stream', size: 9 };
    const opts = ruleFieldOptions(fieldsOf(att, 'item'), { element: att, name: human, group: groups, itemName: 'attachment', fileTypeLabel: 'Bestandstype' });
    assert.deepEqual(opts[0], { path: 'fileType(item)', label: 'Bestandstype', sample: 'powerpoint', group: 'Fields of each attachment', kind: 'fileType' });
    assert.deepEqual(opts.slice(1).map((o) => o.path), ['item.filename', 'item.mimeType', 'item.size']);

    const row = { id: 1, lines: '[{"qty":2,"sku":"a"}]' };
    const fields = [{ key: 'id', path: 'item.id', sample: 1 }, { key: 'lines', path: 'item.lines', sample: row.lines, children: [{ key: 'qty', path: 'item.lines[*].qty', sample: 2 }] }];
    const rowOpts = ruleFieldOptions(fields, { element: row, name: human, group: groups, itemName: 'row' });
    assert.deepEqual(rowOpts.map((o) => [o.path, o.kind || null, o.quantified || false]), [
        ['item.id', null, false], ['item.lines', 'records', false], ['item.lines[*].qty', null, true],
    ]);
    assert.deepEqual(ruleFieldOptions([], { element: null, name: human, group: groups, itemName: 'x' }), []);
});

test('ruleFieldOptions: a parent group (Tier 2) after the item', () => {
    const att = { filename: 'a.pdf' };
    const parent = { fields: [{ key: 'subject', path: 'loop.message.subject', sample: 'Factuur' }], element: { subject: 'Factuur' }, name: 'message' };
    const opts = ruleFieldOptions(fieldsOf(att, 'item'), { element: att, name: human, group: groups, itemName: 'attachment', parent });
    assert.deepEqual(opts.at(-1), { path: 'loop.message.subject', label: 'Subject', sample: 'Factuur', group: 'The message it came from' });
});
