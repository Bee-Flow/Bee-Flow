/**
 * Native Excel charts for the .xlsx writer: a sheet's chart configs (the same
 * shape the editor stores in `settings.sheet.charts`) become DrawingML parts
 * (xl/drawings, xl/charts) that read the sheet's cells by reference. The
 * values the editor sees are also written as c:numCache / c:strCache, so a
 * viewer that does not recalculate still shows the chart.
 *
 * Types (core/documents/sheetChartSpec.js CHART_TYPES):
 *   bar      c:barChart barDir=col, clustered      hbar     barDir=bar, clustered
 *   stacked  c:barChart barDir=col, stacked, overlap 100
 *   line     c:lineChart        area      c:areaChart
 *   pie      c:pieChart         doughnut  c:doughnutChart (holeSize 50)
 *   scatter  c:scatterChart (categoriesRange = numeric x)
 * Several data columns are several series; the name is the text cell above
 * the column's first value, else the column letter. Pie and doughnut use the
 * first column only.
 *
 * kpi tiles have no native chart: they are skipped here (their cells still
 * hold the value). Series colours are the editor's palette (or the chart's own
 * `colors`), number formats become c:numFmt format codes.
 *
 * Pure, no I/O. Called by xlsxWorkbook.buildXlsxWorkbook.
 */

'use strict';

const { xmlEscape, colLetter } = require('./xlsxXml');
const { parseRange } = require('../sheetAssist/sheetRefs');
const { CHART_PALETTE, sizeInPx } = require('../sheetChartFields');

const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const EMU_PER_PX = 9525;
const MAX_SERIES = 20;
const MAX_POINTS = 2000;

/** @param {string} sheet @param {number} c0 @param {number} r0 @param {number} c1 @param {number} r1 */
function refOf(sheet, c0, r0, c1, r1) {
    const a = `$${colLetter(c0)}$${r0 + 1}`;
    const b = `$${colLetter(c1)}$${r1 + 1}`;
    return `'${sheet.replace(/'/g, "''")}'!${a === b ? a : `${a}:${b}`}`;
}

const cellName = (c, r) => `${colLetter(c)}${r + 1}`;

function numCache(values) {
    const pts = values.map((v, i) => (typeof v === 'number' && Number.isFinite(v) ? `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>` : '')).join('');
    return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${pts}</c:numCache>`;
}

function strCache(labels) {
    const pts = labels.map((v, i) => `<c:pt idx="${i}"><c:v>${xmlEscape(v)}</c:v></c:pt>`).join('');
    return `<c:strCache><c:ptCount val="${labels.length}"/>${pts}</c:strCache>`;
}


const CURRENCY_SYMBOLS = { EUR: '€ ', USD: '$ ', GBP: '£ ' };

/**
 * The Excel number format of a chart's `format` (General when none), close to
 * what the editor shows (sheetChartFormat.ts: up to 2 decimals). Excel has no
 * "up to 2 decimals" without a dangling separator ("12."), so the decimals
 * follow the data: none when every value is whole, else 2.
 * @param {any} chart
 * @param {boolean} [whole]  every charted value is an integer
 */
function formatCode(chart, whole = false) {
    const decimals = whole ? '' : '.00';
    if (chart.format === 'percent') return '0.0%';
    if (chart.format === 'currency') {
        const symbol = CURRENCY_SYMBOLS[chart.currency || 'EUR'] || `${String(chart.currency).replace(/[^A-Z]/g, '')} `;
        return `"${symbol}"#,##0${decimals}`;
    }
    if (chart.format === 'number') return `#,##0${decimals}`;
    return 'General';
}

/** Every number the chart's series hold is an integer. */
const allWhole = (data) => data.series.every((s) => s.values.every((v) => v == null || !Number.isFinite(v) || Number.isInteger(v)));

const colorOf = (chart, i) => String((chart.colors && chart.colors.length ? chart.colors : CHART_PALETTE)[i % (chart.colors?.length || CHART_PALETTE.length)]).replace('#', '').toUpperCase();
const fill = (hex) => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
const GRID = '<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E5E7EB"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>';

/** Data labels (showValues): the value, in the chart's number format. */
function labelsXml(chart, whole) {
    if (!chart.showValues) return '';
    const fmt = chart.format ? `<c:numFmt formatCode="${xmlEscape(formatCode(chart, whole))}" sourceLinked="0"/>` : '';
    return `<c:dLbls>${fmt}<c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>`;
}

/** One data point filled with its own colour: a pie slice, or a bar of colorByCategory. */
const pointFills = (chart, n, bar) => Array.from({ length: n }, (_, k) => `<c:dPt><c:idx val="${k}"/>${bar ? '<c:invertIfNegative val="0"/>' : ''}<c:bubble3D val="0"/><c:spPr>${fill(colorOf(chart, k))}</c:spPr></c:dPt>`).join('');

const numRef = (f, values) => `<c:numRef><c:f>${xmlEscape(f)}</c:f>${numCache(values)}</c:numRef>`;
const strRef = (f, labels) => `<c:strRef><c:f>${xmlEscape(f)}</c:f>${strCache(labels)}</c:strRef>`;

/**
 * What a chart reads, resolved against the sheet's computed cells.
 * @returns {{ rows: number, labels: string[]|null, xs: (number|null)[]|null, catRef: string|null, series: { name: string, nameRef: string|null, values: (number|null)[], ref: string }[] } | null}
 */
function resolveChart(chart, sheet, values) {
    const d = parseRange(chart.dataRange);
    if (!d) return null;
    const rows = Math.min(d.r1 - d.r0 + 1, MAX_POINTS);
    const at = (c, r) => values?.[cellName(c, r)];
    const num = (c, r) => { const v = at(c, r)?.value; return typeof v === 'number' && Number.isFinite(v) ? v : null; };
    const cat = chart.categoriesRange ? parseRange(chart.categoriesRange) : null;
    const lastCol = ['pie', 'doughnut'].includes(chart.type) ? d.c0 : Math.min(d.c1, d.c0 + MAX_SERIES - 1);
    const series = [];
    for (let c = d.c0; c <= lastCol; c++) {
        const header = d.r0 > 0 ? at(c, d.r0 - 1) : null;
        const named = header && typeof header.value === 'string' && header.value.trim();
        series.push({
            name: named ? header.value.trim() : colLetter(c),
            nameRef: named ? refOf(sheet, c, d.r0 - 1, c, d.r0 - 1) : null,
            values: Array.from({ length: rows }, (_, i) => num(c, d.r0 + i)),
            ref: refOf(sheet, c, d.r0, c, d.r0 + rows - 1),
        });
    }
    return {
        rows, series,
        labels: cat ? Array.from({ length: rows }, (_, i) => (at(cat.c0, cat.r0 + i)?.display ?? '') || String(i + 1)) : null,
        xs: cat ? Array.from({ length: rows }, (_, i) => num(cat.c0, cat.r0 + i)) : null,
        catRef: cat ? refOf(sheet, cat.c0, cat.r0, cat.c0, cat.r0 + rows - 1) : null,
    };
}

function serXml(chart, data, s, i) {
    const tx = s.nameRef ? `<c:tx>${strRef(s.nameRef, [s.name])}</c:tx>` : `<c:tx><c:v>${xmlEscape(s.name)}</c:v></c:tx>`;
    const head = `<c:idx val="${i}"/><c:order val="${i}"/>${tx}`;
    const val = `<c:val>${numRef(s.ref, s.values)}</c:val>`;
    const cat = data.catRef ? `<c:cat>${strRef(data.catRef, data.labels)}</c:cat>` : '';
    const hex = colorOf(chart, i);
    const lbl = labelsXml(chart, allWhole(data));
    switch (chart.type) {
        case 'line': return `<c:ser>${head}<c:spPr><a:ln w="28575" cap="rnd">${fill(hex)}<a:round/></a:ln></c:spPr><c:marker><c:symbol val="none"/></c:marker>${lbl}${cat}${val}<c:smooth val="0"/></c:ser>`;
        case 'area': return `<c:ser>${head}<c:spPr>${fill(hex)}</c:spPr>${lbl}${cat}${val}</c:ser>`;
        case 'pie': case 'doughnut': return `<c:ser>${head}${pointFills(chart, s.values.length, false)}${lbl}${cat}${val}</c:ser>`;
        case 'scatter':
            return `<c:ser>${head}<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="7"/><c:spPr>${fill(hex)}</c:spPr></c:marker>${lbl}`
                + `<c:xVal>${numRef(data.catRef, data.xs)}</c:xVal><c:yVal>${numRef(s.ref, s.values)}</c:yVal><c:smooth val="0"/></c:ser>`;
        default: {
            const byPoint = chart.colorByCategory && data.series.length === 1;
            return `<c:ser>${head}<c:spPr>${fill(hex)}</c:spPr><c:invertIfNegative val="0"/>${byPoint ? pointFills(chart, s.values.length, true) : ''}${lbl}${cat}${val}</c:ser>`;
        }
    }
}

const AX_IDS = ['111111111', '222222222'];
const axIds = `<c:axId val="${AX_IDS[0]}"/><c:axId val="${AX_IDS[1]}"/>`;

/**
 * The plot-area body for one type: the chart group plus its axes.
 * hbar lists its categories top-down as the editor does: Excel draws a bar
 * chart's first category at the bottom, so the category axis runs maxMin and
 * the value axis crosses it at the far end, which keeps it at the bottom.
 */
function plotXml(chart, sers, whole) {
    const t = chart.type;
    const reversed = t === 'hbar';
    const catAx = (pos) => `<c:catAx><c:axId val="${AX_IDS[0]}"/><c:scaling><c:orientation val="${reversed ? 'maxMin' : 'minMax'}"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/>`
        + '<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>'
        + `<c:crossAx val="${AX_IDS[1]}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
    const code = xmlEscape(formatCode(chart, whole));
    // `plain`: the x axis of a scatter chart holds the categories' numbers, not the chart's format
    const valAx = (id, cross, pos, between, grid = true, plain = false) => `<c:valAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/>`
        + `${grid ? GRID : ''}<c:numFmt formatCode="${plain ? 'General' : code}" sourceLinked="${chart.format && !plain ? 0 : 1}"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>`
        + `<c:crossAx val="${cross}"/><c:crosses val="${reversed ? 'max' : 'autoZero'}"/><c:crossBetween val="${between}"/></c:valAx>`;
    if (t === 'pie') return `<c:pieChart><c:varyColors val="1"/>${sers}<c:firstSliceAng val="0"/></c:pieChart>`;
    if (t === 'doughnut') return `<c:doughnutChart><c:varyColors val="1"/>${sers}<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart>`;
    if (t === 'scatter') {
        return `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${sers}${axIds}</c:scatterChart>`
            + valAx(AX_IDS[0], AX_IDS[1], 'b', 'midCat', false, true) + valAx(AX_IDS[1], AX_IDS[0], 'l', 'midCat');
    }
    if (t === 'line') return `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers}<c:marker val="1"/>${axIds}</c:lineChart>${catAx('b')}${valAx(AX_IDS[1], AX_IDS[0], 'l', 'between')}`;
    if (t === 'area') return `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers}${axIds}</c:areaChart>${catAx('b')}${valAx(AX_IDS[1], AX_IDS[0], 'l', 'midCat')}`;
    const horizontal = t === 'hbar';
    const stacked = t === 'stacked';
    return `<c:barChart><c:barDir val="${horizontal ? 'bar' : 'col'}"/><c:grouping val="${stacked ? 'stacked' : 'clustered'}"/><c:varyColors val="0"/>${sers}`
        + `<c:gapWidth val="150"/>${stacked ? '<c:overlap val="100"/>' : ''}${axIds}</c:barChart>`
        + `${catAx(horizontal ? 'l' : 'b')}${valAx(AX_IDS[1], AX_IDS[0], horizontal ? 'b' : 'l', 'between')}`;
}

/**
 * One chart's XML (c:chartSpace), or null when its ranges are not readable.
 * @param {any} chart  { type, title?, dataRange, categoriesRange? }
 * @param {string} sheet  the worksheet it reads
 * @param {Record<string, { value: any, display?: string }>} [values]  computed cells
 */
function chartXml(chart, sheet, values) {
    if (chart.type === 'kpi') return null;
    const data = resolveChart(chart, sheet, values);
    if (!data || !data.series.length) return null;
    if (chart.type === 'scatter' && !data.catRef) return null;
    const sers = data.series.map((s, i) => serXml(chart, data, s, i)).join('');
    const title = chart.title
        ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${xmlEscape(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`
        : '';
    const legend = data.series.length > 1 || chart.type === 'pie' || chart.type === 'doughnut'
        ? '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>' : '';
    return `${XML_HEAD}<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:roundedCorners val="0"/><c:chart>${title}`
        + `<c:autoTitleDeleted val="${chart.title ? 0 : 1}"/><c:plotArea><c:layout/>${plotXml(chart, sers, allWhole(data))}</c:plotArea>${legend}`
        + '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>';
}

function anchorXml(chart, rId, n) {
    const a = parseRange(chart.anchor) || { c0: 0, r0: 0 };
    // the editor's size, or its default (6 x 14 cells) for a chart stored without one
    const { width, height } = sizeInPx(chart);
    const cx = Math.round(width * EMU_PER_PX);
    const cy = Math.round(height * EMU_PER_PX);
    return `<xdr:oneCellAnchor><xdr:from><xdr:col>${a.c0}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.r0}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
        + `<xdr:ext cx="${cx}" cy="${cy}"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${n + 1}" name="Chart ${n}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>`
        + '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>'
        + `<a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" xmlns:r="${NS_R}" r:id="${rId}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>`;
}

const relsXml = (items) => `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;

/**
 * The extra package parts for the charts of all sheets.
 * @param {{ name: string, charts?: any[], values?: Record<string, any> }[]} sheets  in worksheet order, names final
 * @returns {{ files: Record<string, string>, sheetRels: Record<number, true>, contentTypes: string }}
 *   `sheetRels[i]` is set when worksheet i (0-based) needs `<drawing r:id="rId1"/>`
 */
function chartPartsFor(sheets) {
    const files = {};
    const sheetRels = {};
    let contentTypes = '';
    let chartNo = 0;
    let drawingNo = 0;
    sheets.forEach((sh, i) => {
        const built = (sh.charts || []).map((c) => ({ c, xml: chartXml(c, sh.name, sh.values) })).filter((x) => x.xml);
        if (!built.length) return;
        drawingNo += 1;
        let anchors = '';
        let rels = '';
        built.forEach(({ c, xml }, j) => {
            chartNo += 1;
            files[`xl/charts/chart${chartNo}.xml`] = xml;
            contentTypes += `<Override PartName="/xl/charts/chart${chartNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`;
            rels += `<Relationship Id="rId${j + 1}" Type="${NS_R}/chart" Target="../charts/chart${chartNo}.xml"/>`;
            anchors += anchorXml(c, `rId${j + 1}`, j + 1);
        });
        files[`xl/drawings/drawing${drawingNo}.xml`] = `${XML_HEAD}<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}">${anchors}</xdr:wsDr>`;
        files[`xl/drawings/_rels/drawing${drawingNo}.xml.rels`] = relsXml(rels);
        files[`xl/worksheets/_rels/sheet${i + 1}.xml.rels`] = relsXml(`<Relationship Id="rId1" Type="${NS_R}/drawing" Target="../drawings/drawing${drawingNo}.xml"/>`);
        contentTypes += `<Override PartName="/xl/drawings/drawing${drawingNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`;
        sheetRels[i] = true;
    });
    return { files, sheetRels, contentTypes };
}

module.exports = { chartPartsFor, chartXml };
