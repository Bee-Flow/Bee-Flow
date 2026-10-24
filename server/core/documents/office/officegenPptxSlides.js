const { SLIDE_W, BAND_H, BODY_BOTTOM, pptxHex, assertDataImage, cardFill, fitBox, bulletRuns, addBulletsBody } = require('./officegenPptxBase');
const { readableOn, mix: mixHex } = require('../deckThemeOptions');

/** The title of a content slide, set the way the preset says. */
function addTitle(slide, title, th) {
    if (!title) return;
    if (th.titleStyle === 'band') {
        slide.addText(title, {
            x: 0.4, y: 0.1, w: th.brandOnSlides && th.brandName ? 7.1 : 9.2, h: BAND_H - 0.2,
            fontSize: 24, bold: true, color: th.titleColor, fontFace: th.titleFont, valign: 'middle', fit: 'shrink',
        });
        return;
    }
    // A template's corner logo pushes the title to its right.
    const x = Math.max(0.5, th.titleInset * SLIDE_W + 0.25);
    slide.addText(title, {
        x, y: 0.3, w: 9.5 - x, h: 0.8,
        fontSize: 26, bold: true, color: th.titleColor, fontFace: th.titleFont, valign: 'middle', fit: 'shrink',
    });
    if (th.titleStyle === 'rule') {
        slide.addShape('rect', { x, y: 1.12, w: 1.4, h: 0.05, fill: { color: th.accentOnSlide }, line: { color: th.accentOnSlide, width: 0 } });
    }
}

function addCover(pptx, deck, th, { title, author, date, notes } = {}) {
    const slide = pptx.addSlide({ masterName: 'BF_COVER' });
    const templ = !!th.template;
    const split = !templ && th.coverStyle === 'split';
    const light = !templ && th.coverStyle === 'light';
    // On a template's picture the words wear the text colour resolved
    // against it; the preset's accent block/light/split does not apply.
    const titleColor = templ ? th.text : (light ? th.accentOnSlide : (split ? th.accentOnSlide : th.onAccent));
    const subColor = templ ? th.text : (light || split ? th.text : th.onAccent);
    const metaColor = templ ? th.muted : (light || split ? th.muted : th.onAccent);
    const x = split ? 4.0 : 0.6;
    const w = split ? 5.6 : 8.8;
    slide.addText(title || deck.title || 'Presentation', {
        x, y: light ? 1.7 : 1.35, w, h: 1.7, fontSize: 36, bold: true, color: titleColor, fontFace: th.titleFont, valign: 'bottom', fit: 'shrink',
    });
    if (deck.subtitle) {
        slide.addText(deck.subtitle, { x, y: light ? 3.5 : 3.15, w, h: 0.8, fontSize: 18, color: subColor, fontFace: th.bodyFont, valign: 'top', transparency: light || split || templ ? 0 : 10, fit: 'shrink' });
    }
    const meta = [author || deck.author, date || deck.date].filter(Boolean).join('  ·  ');
    if (meta) {
        slide.addText(meta, { x, y: light ? 4.3 : 3.95, w, h: 0.4, fontSize: 12, color: metaColor, fontFace: th.bodyFont, transparency: light || split || templ ? 0 : 20 });
    }
    if (notes) slide.addNotes(String(notes));
    return slide;
}

function tableCellOptions(th, { header = false, rowIndex = 0, numeric = false } = {}) {
    const base = { fontFace: th.bodyFont, align: numeric ? 'right' : 'left', valign: 'middle' };
    const none = { type: 'none' };
    const line = { type: 'solid', pt: 0.75, color: th.tableLine };
    if (th.tableStyle === 'banded') {
        if (header) return { ...base, bold: true, color: th.tableHeaderText, fill: { color: th.tableHeaderFill }, border: { type: 'solid', pt: 0.5, color: th.tableLine } };
        return { ...base, color: th.text, fill: { color: rowIndex % 2 === 1 ? th.tableBand : th.background }, border: { type: 'solid', pt: 0.5, color: th.tableLine } };
    }
    if (th.tableStyle === 'lines') {
        if (header) return { ...base, bold: true, color: th.accentOnSlide, border: [none, none, { type: 'solid', pt: 1.5, color: th.accentOnSlide }, none] };
        return { ...base, color: th.text, border: [none, none, line, none] };
    }
    // minimal
    if (header) return { ...base, bold: true, color: th.accentOnSlide, border: none };
    return { ...base, color: th.text, border: none };
}

function addTableSlide(slide, s, th, top) {
    const t = s.table;
    const cols = t.columns.length;
    const header = t.columns.map((c) => ({ text: String(c), options: tableCellOptions(th, { header: true }) }));
    const rows = t.rows.map((r, ri) => r.map((v) => ({
        text: typeof v === 'number' ? String(v) : String(v ?? ''),
        options: tableCellOptions(th, { rowIndex: ri, numeric: typeof v === 'number' }),
    })));
    const bodyH = BODY_BOTTOM - top;
    const tableH = s.bullets.length || s.body ? Math.min(2.4, bodyH) : bodyH;
    slide.addTable([header, ...rows], {
        x: 0.5, y: top, w: 9, colW: Array(cols).fill(9 / cols),
        fontSize: rows.length > 8 ? 10 : 12, fontFace: th.bodyFont, color: th.text,
        autoPage: false, rowH: Math.min(0.4, tableH / (rows.length + 1)), valign: 'middle',
    });
    if (s.bullets.length || s.body) addBulletsBody(slide, s, th, { x: 0.5, y: top + tableH + 0.1, w: 9, h: bodyH - tableH - 0.1 });
}

function addImageSlide(slide, s, th, top) {
    const data = assertDataImage(s.image.dataUrl, `slide "${s.title || '?'}" image`);
    const h = BODY_BOTTOM - top;
    // The box follows the picture's own proportions (measured by the renderer;
    // 4:3 when unknown) — see fitBox for why not `sizing`.
    const aspect = s.image.aspect || 4 / 3;
    if (s.bullets.length || s.body) {
        addBulletsBody(slide, s, th, { x: 0.5, y: top, w: 4.5, h });
        slide.addImage({ data, ...fitBox(aspect, 5.2, top, 4.3, h, { align: 'center' }) });
    } else {
        slide.addImage({ data, ...fitBox(aspect, 0.5, top, 9, h, { align: 'center' }) });
    }
}

function addQuoteSlide(slide, s, th, top) {
    // A large quote mark in the accent tint sets the tone; the words stay in
    // the text colour and read on their own.
    if (th.glass) slide.addShape('roundRect', { x: 0.5, y: top + 0.15, w: 9, h: 3.4, rectRadius: 0.1, fill: cardFill(th), line: { color: th.statFill, width: 0, transparency: 100 } });
    slide.addText('“', { x: 0.6, y: top - 0.1, w: 1.2, h: 1.2, fontSize: 96, bold: true, color: th.glass ? th.text : th.statFill, transparency: th.glass ? 60 : 0, fontFace: th.titleFont, valign: 'top', margin: 0 });
    slide.addText(s.quote.text, {
        x: 1.2, y: top + 0.5, w: 7.8, h: 2.4, fontSize: 26, italic: true, color: th.text, fontFace: th.titleFont, valign: 'middle', fit: 'shrink',
    });
    if (s.quote.attribution) {
        slide.addShape('rect', { x: 1.2, y: top + 3.05, w: 0.5, h: 0.04, fill: { color: th.accentOnSlide }, line: { color: th.accentOnSlide, width: 0 } });
        slide.addText(s.quote.attribution, { x: 1.85, y: top + 2.85, w: 7.1, h: 0.45, fontSize: 13, color: th.muted, fontFace: th.bodyFont, valign: 'middle' });
    }
    if (s.bullets.length || s.body) addBulletsBody(slide, s, th, { x: 0.8, y: top + 3.4, w: 8.4, h: BODY_BOTTOM - top - 3.4 });
}

function addTwoColumnSlide(slide, s, th, top) {
    const boxes = [{ x: 0.5, w: 4.4 }, { x: 5.1, w: 4.4 }];
    const cardH = (s.body ? 4.4 : BODY_BOTTOM) - top;
    s.columns.forEach((col, i) => {
        const b = boxes[i];
        // Each column on a soft card, its heading on an accent tab.
        slide.addShape('roundRect', { x: b.x, y: top, w: b.w, h: cardH, rectRadius: 0.1, fill: cardFill(th), line: { color: th.statFill, width: 0, transparency: 100 } });
        let y = top + 0.2;
        if (col.title) {
            slide.addShape('rect', { x: b.x + 0.3, y: y + 0.12, w: 0.06, h: 0.3, fill: { color: th.accentOnSlide }, line: { color: th.accentOnSlide, width: 0 } });
            slide.addText(col.title, { x: b.x + 0.45, y, w: b.w - 0.7, h: 0.5, fontSize: 17, bold: true, color: th.text, fontFace: th.titleFont, valign: 'middle' });
            y += 0.6;
        }
        if (col.bullets.length) {
            slide.addText(bulletRuns(col.bullets, th, { fontSize: 16, subSize: 14 }), { x: b.x + 0.3, y, w: b.w - 0.5, h: top + cardH - y - 0.15, valign: 'top', fontFace: th.bodyFont, fit: 'shrink' });
        }
    });
    if (s.body) slide.addText(s.body, { x: 0.5, y: 4.55, w: 9, h: 0.45, fontSize: 14, color: th.muted, fontFace: th.bodyFont, fit: 'shrink' });
}

function addSectionSlide(pptx, s, th) {
    const slide = pptx.addSlide({ masterName: 'BF_SECTION' });
    slide.addText(s.title || '', { x: 0.6, y: 1.7, w: 8.8, h: 1.15, fontSize: 32, bold: true, color: th.accentOnSlide, fontFace: th.titleFont, valign: 'bottom', fit: 'shrink' });
    const sub = s.body || s.bullets.map((b) => b.text).join('  ·  ');
    if (sub) slide.addText(sub, { x: 0.6, y: 3.15, w: 8.8, h: 1.0, fontSize: 16, color: th.muted, fontFace: th.bodyFont, valign: 'top', fit: 'shrink' });
    return slide;
}

function addClosingSlide(pptx, s, th) {
    const lines = [s.body, ...s.bullets.map((b) => b.text)].filter(Boolean).join('\n');
    return addCover(pptx, { title: s.title || 'Thank you', subtitle: lines || null }, th, { title: s.title || 'Thank you' });
}

const PPTX_CHART_TYPE = Object.freeze({ column: 'bar', bar: 'bar', line: 'line', area: 'area', pie: 'pie', donut: 'doughnut' });

/**
 * A NATIVE chart — editable in PowerPoint and Collabora, its data a real
 * sheet inside the file. Colours, fonts and grid come from the theme so a
 * chart sits in the deck like a table does.
 */
function addChartSlide(pptx, slide, s, th, top) {
    const c = s.chart;
    const h = BODY_BOTTOM - top;
    const withText = s.bullets.length || s.body;
    const box = withText ? { x: 5.0, y: top, w: 4.6, h } : { x: 0.5, y: top, w: 9, h };
    if (withText) addBulletsBody(slide, s, th, { x: 0.5, y: top, w: 4.3, h });
    const circular = c.type === 'pie' || c.type === 'donut';
    // An UNSTACKED area chart paints every series from the axis up, later
    // series on top: an opaque big series hides a small one completely.
    // So the biggest is drawn first and the fills are translucent.
    const overlapArea = c.type === 'area' && !c.stacked && c.series.length > 1;
    const order = overlapArea
        ? c.series.map((ser, i) => ({ i, peak: Math.max(...ser.values.filter((v) => typeof v === 'number'), 0) })).sort((a, b) => b.peak - a.peak).map((x) => x.i)
        : c.series.map((_, i) => i);
    const data = order.map((i) => ({ name: c.series[i].name || `Series ${i + 1}`, labels: c.labels, values: c.series[i].values.map((v) => (typeof v === 'number' ? v : 0)) }));
    const colours = order.map((i) => th.chartColors[i % th.chartColors.length]);
    const font = th.bodyFont;
    // The marks follow the data-viz spec: recessive hairline grid, no axis
    // lines, thin bars with a surface gap between neighbours, 2pt lines with
    // ringed markers, value labels only where they stay sparse.
    const grid = pptxHex(mixHex(`#${th.background}`, `#${th.text}`, 0.12), th.tableLine);
    const points = c.labels.length * c.series.length;
    const sparse = points <= 12;
    const opts = {
        ...box,
        chartColors: colours,
        // On a template's picture the chart has no plate of its own.
        chartArea: { ...(th.template ? {} : { fill: { color: th.background } }), roundedCorners: false },
        plotArea: th.template ? {} : { fill: { color: th.background } },
        showLegend: c.series.length > 1 || circular,
        legendPos: circular ? 'r' : 'b', legendColor: th.muted, legendFontFace: font, legendFontSize: 10,
        showTitle: !!c.title, title: c.title || undefined, titleColor: th.text, titleFontFace: font, titleFontSize: 13,
        dataLabelColor: th.text, dataLabelFontFace: font, dataLabelFontSize: 10,
    };
    if (circular) {
        Object.assign(opts, {
            showPercent: c.showValues, showValue: false, showLabel: false, showLeaderLines: false,
            dataLabelPosition: c.type === 'donut' ? 'ctr' : 'bestFit',
            dataBorder: { pt: 2, color: th.background },
            ...(c.type === 'donut' ? { holeSize: 62 } : {}),
        });
        opts.dataLabelColor = pptxHex(readableOn(`#${th.chartColors[0]}`, null, 3), th.text);
    } else {
        Object.assign(opts, {
            showValue: c.showValues && sparse, dataLabelFormatCode: '#,##0.##',
            catAxisLabelColor: th.muted, catAxisLabelFontFace: font, catAxisLabelFontSize: 10, catAxisLineShow: false, catGridLine: { style: 'none' },
            valAxisLabelColor: th.muted, valAxisLabelFontFace: font, valAxisLabelFontSize: 9, valAxisLineShow: false,
            valGridLine: { color: grid, style: 'solid', size: 0.5 }, valAxisLabelFormatCode: '#,##0.##',
            ...(c.unit ? { showValAxisTitle: true, valAxisTitle: c.unit, valAxisTitleColor: th.muted, valAxisTitleFontFace: font, valAxisTitleFontSize: 9 } : {}),
        });
        if (c.type === 'column' || c.type === 'bar') {
            Object.assign(opts, {
                barDir: c.type === 'bar' ? 'bar' : 'col',
                barGrouping: c.stacked ? 'stacked' : 'clustered',
                // Thin marks: the gap is wider than the bar; neighbours in a
                // cluster and segments in a stack are parted by the surface.
                barGapWidthPct: c.stacked ? 150 : 110,
                ...(c.stacked ? { dataBorder: { pt: 1.5, color: th.background } } : { barOverlapPct: -8 }),
                dataLabelPosition: c.stacked ? 'ctr' : 'outEnd',
            });
        } else {
            Object.assign(opts, {
                lineSize: 2, lineDataSymbol: 'circle', lineDataSymbolSize: 8,
                lineDataSymbolLineColor: th.background, lineDataSymbolLineSize: 1.5,
                dataLabelPosition: 't',
                ...(c.type === 'area' ? { chartColorsOpacity: c.series.length > 1 ? 22 : 30 } : {}),
                ...(c.type === 'area' && c.stacked ? { barGrouping: 'stacked' } : {}),
            });
        }
    }
    slide.addChart(pptx.ChartType[PPTX_CHART_TYPE[c.type] || 'bar'], data, opts);
}

/**
 * KPI tiles: up to four soft cards, each with an accent bar on the left, the
 * value in the text colour (text never wears the data colour), a quiet
 * label and the change beneath it.
 */
function addStatsSlide(slide, s, th, top) {
    const tiles = s.stats;
    const n = tiles.length;
    const gap = 0.25;
    const w = (9 - gap * (n - 1)) / n;
    const withText = s.bullets.length || s.body;
    const h = withText ? 1.7 : Math.min(2.1, BODY_BOTTOM - top - 0.2);
    const y = withText ? top : top + (BODY_BOTTOM - top - h) / 2;
    tiles.forEach((t, i) => {
        const x = 0.5 + i * (w + gap);
        slide.addShape('roundRect', { x, y, w, h, rectRadius: 0.1, fill: cardFill(th), line: { color: th.statFill, width: 0, transparency: 100 } });
        if (t.iconDataUrl) slide.addImage({ data: t.iconDataUrl, x: x + w - 0.6, y: y + 0.18, w: 0.36, h: 0.36 });
        slide.addShape('rect', { x: x + 0.14, y: y + 0.3, w: 0.06, h: h - 0.6, fill: { color: th.accentOnSlide }, line: { color: th.accentOnSlide, width: 0 } });
        const runs = [
            { text: t.value, options: { fontSize: n > 3 ? 26 : 32, bold: true, color: th.text, fontFace: th.titleFont, breakLine: true, paraSpaceAfter: 4 } },
            { text: t.label || ' ', options: { fontSize: 11, color: th.muted, fontFace: th.bodyFont, charSpacing: 1, breakLine: !!t.delta } },
        ];
        if (t.delta) runs.push({ text: t.delta, options: { fontSize: 11, bold: true, color: th.accentOnSlide, fontFace: th.bodyFont } });
        slide.addText(runs, { x: x + 0.32, y, w: w - 0.44, h, align: 'left', valign: 'middle', margin: 4, fit: 'shrink' });
    });
    if (withText) addBulletsBody(slide, s, th, { x: 0.5, y: y + h + 0.2, w: 9, h: BODY_BOTTOM - y - h - 0.2 });
}

/**
 * Cards: two to six titled texts on soft cards — in a row up to three, a
 * grid beyond that. A card may carry an icon (rasterised Lucide, in the
 * accent) at its top or a picture across its top.
 */
function addCardsSlide(slide, s, th, top) {
    const cards = s.cards;
    const n = cards.length;
    let y = top;
    if (s.body) {
        slide.addText(s.body, { x: 0.5, y, w: 9, h: 0.85, fontSize: 15, color: th.text, fontFace: th.bodyFont, valign: 'top', fit: 'shrink' });
        y += 0.95;
    }
    const cols = n <= 3 ? n : (n === 4 ? (s.body ? 2 : 4) : 3);
    const rows = Math.ceil(n / cols);
    const gap = 0.22;
    const w = (9 - gap * (cols - 1)) / cols;
    const h = (BODY_BOTTOM - y - gap * (rows - 1)) / rows;
    const small = n > 3;
    cards.forEach((c, i) => {
        const x = 0.5 + (i % cols) * (w + gap);
        const cy = y + Math.floor(i / cols) * (h + gap);
        slide.addShape('roundRect', { x, y: cy, w, h, rectRadius: 0.1, fill: cardFill(th), line: { color: th.statFill, width: 0, transparency: 100 } });
        let textY = cy + 0.22;
        if (c.image && c.image.dataUrl) {
            const imgH = Math.min(h * 0.45, 1.3);
            slide.addImage({ data: c.image.dataUrl, ...fitBox(c.image.aspect || 4 / 3, x + 0.18, cy + 0.18, w - 0.36, imgH, { align: 'left', valign: 'top' }) });
            textY = cy + 0.18 + imgH + 0.12;
        } else if (c.iconDataUrl) {
            const size = small ? 0.34 : 0.42;
            slide.addImage({ data: c.iconDataUrl, x: x + 0.22, y: cy + 0.22, w: size, h: size });
            textY = cy + 0.22 + size + 0.1;
        } else {
            slide.addShape('rect', { x: x + 0.22, y: cy + 0.3, w: 0.05, h: 0.34, fill: { color: th.accentOnSlide }, line: { color: th.accentOnSlide, width: 0 } });
        }
        const runs = [];
        if (c.title) runs.push({ text: c.title, options: { fontSize: small ? 13 : 16, bold: true, color: th.text, fontFace: th.titleFont, breakLine: !!c.text, paraSpaceAfter: 5 } });
        if (c.text) runs.push({ text: c.text, options: { fontSize: small ? 10.5 : 12.5, color: th.text, fontFace: th.bodyFont } });
        const indent = c.image || c.iconDataUrl ? 0.22 : 0.38;
        slide.addText(runs, { x: x + indent, y: textY, w: w - indent - 0.18, h: cy + h - textY - 0.15, valign: 'top', margin: 0, fit: 'shrink' });
    });
}

/** A process / timeline: a line across the slide, numbered circles, a title and a line of text under each. */
function addTimelineSlide(slide, s, th, top) {
    const steps = s.steps;
    const n = steps.length;
    const withText = s.body;
    const lineY = top + 0.8;
    const r = 0.26;
    const slot = 9 / n;
    slide.addShape('line', { x: 0.5 + slot / 2, y: lineY, w: 9 - slot, h: 0, line: { color: th.statFill, width: 4 } });
    steps.forEach((st, i) => {
        const cx = 0.5 + slot * i + slot / 2;
        // A surface ring around each node, so it reads on the connector.
        slide.addShape('ellipse', { x: cx - r - 0.05, y: lineY - r - 0.05, w: r * 2 + 0.1, h: r * 2 + 0.1, fill: { color: th.background }, line: { color: th.background, width: 0 } });
        slide.addShape('ellipse', { x: cx - r, y: lineY - r, w: r * 2, h: r * 2, fill: { color: th.accentOnSlide }, line: { color: th.accentOnSlide, width: 0 } });
        slide.addText(String(i + 1), { x: cx - r, y: lineY - r, w: r * 2, h: r * 2, fontSize: 13, bold: true, color: pptxHex(readableOn(`#${th.accentOnSlide}`, null, 3), th.background), fontFace: th.bodyFont, align: 'center', valign: 'middle', margin: 0 });
        slide.addText(st.title, { x: cx - slot / 2 + 0.05, y: lineY + r + 0.15, w: slot - 0.1, h: 0.55, fontSize: n > 4 ? 13 : 15, bold: true, color: th.text, fontFace: th.titleFont, align: 'center', valign: 'top', fit: 'shrink' });
        if (st.text) slide.addText(st.text, { x: cx - slot / 2 + 0.05, y: lineY + r + 0.7, w: slot - 0.1, h: 1.1, fontSize: n > 4 ? 10 : 12, color: th.muted, fontFace: th.bodyFont, align: 'center', valign: 'top', fit: 'shrink' });
    });
    if (withText) slide.addText(s.body, { x: 0.5, y: 4.2, w: 9, h: BODY_BOTTOM - 4.2, fontSize: 13, color: th.muted, fontFace: th.bodyFont, fit: 'shrink' });
}

module.exports = { addTitle, addCover, addTableSlide, addImageSlide, addQuoteSlide, addTwoColumnSlide, addSectionSlide, addClosingSlide, addChartSlide, addStatsSlide, addCardsSlide, addTimelineSlide };
