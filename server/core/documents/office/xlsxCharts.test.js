'use strict';

/**
 * Native Excel charts in the .xlsx writer (office/xlsxCharts.js).
 *
 * Run: cd server && node --test core/documents/office/xlsxCharts.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const { XMLValidator } = require('fast-xml-parser');
const { buildXlsxWorkbook } = require('./xlsxWorkbook');
const { chartXml: rawChartXml } = require('./xlsxCharts');
const { CHART_TYPES } = require('../sheetChartSpec');

const values = {
    A1: { value: 'Month', display: 'Month' }, B1: { value: 'Sales', display: 'Sales' }, C1: { value: 'Costs', display: 'Costs' },
    A2: { value: 'Jan', display: 'Jan' }, B2: { value: 10, display: '10' }, C2: { value: 4, display: '4' },
    A3: { value: 'Feb', display: 'Feb' }, B3: { value: 20, display: '20' }, C3: { value: 6, display: '6' },
    D1: { value: 'x', display: 'x' }, D2: { value: 1, display: '1' }, D3: { value: 2, display: '2' },
};
/** &apos; is how the writer escapes a quote; read it back as one. */
const chartXml = (...args) => rawChartXml(...args)?.replace(/&apos;/g, "'") ?? null;
const base = { anchor: 'F2', width: 320, height: 220 };

async function unzip(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const out = {};
    for (const name of Object.keys(zip.files)) if (!zip.files[name].dir) out[name] = await zip.file(name).async('string');
    return out;
}

test('every chart type is well-formed XML with the right group element', () => {
    const groups = { bar: 'barChart', hbar: 'barChart', stacked: 'barChart', line: 'lineChart', area: 'areaChart', pie: 'pieChart', doughnut: 'doughnutChart', scatter: 'scatterChart' };
    assert.deepStrictEqual(Object.keys(groups).sort(), CHART_TYPES.filter((t) => t !== 'kpi').sort());
    assert.strictEqual(chartXml({ ...base, type: 'kpi', dataRange: 'B2' }, 'Main', values), null, 'a kpi tile has no native chart');
    for (const type of Object.keys(groups)) {
        const xml = chartXml({ ...base, type, dataRange: 'B2:C3', categoriesRange: type === 'scatter' ? 'D2:D3' : 'A2:A3', title: 'T & "q"' }, 'Main', values);
        assert.strictEqual(XMLValidator.validate(xml), true, type);
        assert.match(xml, new RegExp(`<c:${groups[type]}>`), type);
        assert.match(xml, /<a:t>T &amp; &quot;q&quot;<\/a:t>/);
    }
});

test('bar directions, grouping, overlap and hole size', () => {
    const r = (type) => chartXml({ ...base, type, dataRange: 'B2:C3' }, 'Main', values);
    assert.match(r('bar'), /<c:barDir val="col"\/><c:grouping val="clustered"\/>/);
    assert.match(r('hbar'), /<c:barDir val="bar"\/><c:grouping val="clustered"\/>/);
    assert.match(r('hbar'), /<c:axPos val="l"\/>/);
    assert.match(r('stacked'), /<c:grouping val="stacked"\/>[\s\S]*<c:overlap val="100"\/>/);
    assert.doesNotMatch(r('bar'), /c:overlap/);
    assert.match(r('doughnut'), /<c:holeSize val="50"\/>/);
});

test('multi-column data gives named series, a legend and quoted absolute refs', () => {
    const xml = chartXml({ ...base, type: 'bar', dataRange: 'B2:C3', categoriesRange: 'A2:A3' }, "Q'1 data", values);
    assert.strictEqual((xml.match(/<c:ser>/g) || []).length, 2);
    assert.match(xml, /<c:f>'Q''1 data'!\$B\$1<\/c:f>/);
    assert.match(xml, /<c:f>'Q''1 data'!\$C\$2:\$C\$3<\/c:f>/);
    assert.match(xml, /<c:cat><c:strRef><c:f>'Q''1 data'!\$A\$2:\$A\$3<\/c:f>/);
    assert.match(xml, /<c:legend>/);
    assert.match(xml, /<c:v>Sales<\/c:v>/);
    assert.match(xml, /<c:pt idx="1"><c:v>20<\/c:v>/);
    assert.doesNotMatch(xml, /<c:title>/);
});

test('a header-less column is named by its letter; one series has no legend; pie keeps the first column and a legend', () => {
    const noHeader = chartXml({ ...base, type: 'line', dataRange: 'B1:B3' }, 'Main', { B1: { value: 5, display: '5' } });
    assert.match(noHeader, /<c:tx><c:v>B<\/c:v><\/c:tx>/);
    assert.doesNotMatch(noHeader, /<c:legend>/);
    const pie = chartXml({ ...base, type: 'pie', dataRange: 'B2:C3', categoriesRange: 'A2:A3' }, 'Main', values);
    assert.strictEqual((pie.match(/<c:ser>/g) || []).length, 1);
    assert.match(pie, /<c:legend>/);
});

test('scatter reads x from the categories range and is skipped without one', () => {
    const xml = chartXml({ ...base, type: 'scatter', dataRange: 'B2:C3', categoriesRange: 'D2:D3' }, 'Main', values);
    assert.match(xml, /<c:xVal><c:numRef><c:f>'Main'!\$D\$2:\$D\$3<\/c:f>/);
    assert.match(xml, /<c:yVal>/);
    assert.strictEqual((xml.match(/<c:valAx>/g) || []).length, 2);
    assert.strictEqual(chartXml({ ...base, type: 'scatter', dataRange: 'B2:C3' }, 'Main', values), null);
});

test('a workbook with two tabs gets drawings, charts, rels and content types', async () => {
    const buffer = await buildXlsxWorkbook([
        { name: 'Main', matrix: [['Month', 'Sales']], charts: [{ ...base, type: 'bar', dataRange: 'B2:B3', categoriesRange: 'A2:A3' }, { ...base, anchor: 'H2', type: 'pie', dataRange: 'B2:B3' }], values },
        { name: 'My Tab', matrix: [['a']], charts: [{ ...base, type: 'stacked', dataRange: 'B2:C3' }], values },
        { name: 'Plain', matrix: [['a']] },
    ], { formulas: true });
    const p = await unzip(buffer);
    for (const [name, xml] of Object.entries(p)) assert.strictEqual(XMLValidator.validate(xml), true, name);
    assert.deepStrictEqual(Object.keys(p).filter((n) => /chart|drawing|worksheets\/_rels/.test(n)).sort(), [
        'xl/charts/chart1.xml', 'xl/charts/chart2.xml', 'xl/charts/chart3.xml',
        'xl/drawings/_rels/drawing1.xml.rels', 'xl/drawings/_rels/drawing2.xml.rels', 'xl/drawings/drawing1.xml', 'xl/drawings/drawing2.xml',
        'xl/worksheets/_rels/sheet1.xml.rels', 'xl/worksheets/_rels/sheet2.xml.rels',
    ]);
    assert.match(p['xl/worksheets/sheet1.xml'], /<\/sheetData><drawing r:id="rId1"\/><\/worksheet>/);
    assert.match(p['xl/worksheets/sheet1.xml'], /xmlns:r=/);
    assert.doesNotMatch(p['xl/worksheets/sheet3.xml'], /<drawing/);
    assert.match(p['xl/worksheets/_rels/sheet2.xml.rels'], /Target="\.\.\/drawings\/drawing2\.xml"/);
    assert.match(p['xl/drawings/_rels/drawing1.xml.rels'], /rId1[^>]*Target="\.\.\/charts\/chart1\.xml"[\s\S]*rId2[^>]*Target="\.\.\/charts\/chart2\.xml"/);
    assert.match(p['xl/drawings/_rels/drawing2.xml.rels'], /Target="\.\.\/charts\/chart3\.xml"/);
    assert.match(p['xl/drawings/drawing1.xml'], /<xdr:col>5<\/xdr:col><xdr:colOff>0<\/xdr:colOff><xdr:row>1<\/xdr:row>/);
    assert.match(p['xl/drawings/drawing1.xml'], /<xdr:ext cx="3048000" cy="2095500"\/>/);
    assert.match(p['xl/drawings/drawing1.xml'], /<xdr:col>7<\/xdr:col>/);
    assert.match(p['xl/charts/chart3.xml'].replace(/&apos;/g, "'"), /<c:f>'My Tab'!\$B\$2:\$B\$3<\/c:f>/);
    const types = p['[Content_Types].xml'];
    assert.strictEqual((types.match(/drawingml\.chart\+xml/g) || []).length, 3);
    assert.strictEqual((types.match(/officedocument\.drawing\+xml/g) || []).length, 2);
    assert.match(types, /PartName="\/xl\/charts\/chart3\.xml"/);
});

test('a workbook without charts has no drawing parts', async () => {
    const p = await unzip(await buildXlsxWorkbook([{ name: 'A', matrix: [['x']] }]));
    assert.ok(!Object.keys(p).some((n) => /chart|drawing/.test(n)));
    assert.doesNotMatch(p['xl/worksheets/sheet1.xml'], /<drawing/);
});

test('palette colours per series, own colours, pie slices, number formats, data labels', () => {
    const two = chartXml({ ...base, type: 'bar', dataRange: 'B2:C3', format: 'currency', currency: 'EUR', showValues: true }, 'Main', values);
    assert.match(two, /<c:ser><c:idx val="0"\/>[\s\S]*?<a:srgbClr val="4E79A7"\/>/);
    assert.match(two, /<c:ser><c:idx val="1"\/>[\s\S]*?<a:srgbClr val="F28E2B"\/>/);
    assert.match(two, /<c:numFmt formatCode="&quot;€ &quot;#,##0" sourceLinked="0"\/>/);
    assert.match(two, /<c:dLbls>[\s\S]*<c:showVal val="1"\/>/);
    assert.match(two, /<c:legendPos val="b"\/>/);
    const own = chartXml({ ...base, type: 'line', dataRange: 'B2:B3', colors: ['#112233'] }, 'Main', values);
    assert.match(own, /<a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="112233"\/>/);
    const pie = chartXml({ ...base, type: 'pie', dataRange: 'B2:B3' }, 'Main', values);
    assert.match(pie, /<c:dPt><c:idx val="0"\/>[\s\S]*4E79A7[\s\S]*<c:dPt><c:idx val="1"\/>[\s\S]*F28E2B/);
    const byCat = chartXml({ ...base, type: 'bar', dataRange: 'B2:B3', colorByCategory: true }, 'Main', values);
    assert.strictEqual((byCat.match(/<c:dPt>/g) || []).length, 2);
    assert.match(chartXml({ ...base, type: 'area', dataRange: 'B2:B3', format: 'percent' }, 'Main', values), /formatCode="0\.0%" sourceLinked="0"/);
    for (const x of [two, own, pie, byCat]) assert.strictEqual(XMLValidator.validate(x), true);
});
