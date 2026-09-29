'use strict';
/**
 * How a test sentence is scored against what a matcher found in it.
 *
 *   - A gold span (a part the admin marked "should be hidden") is FOUND when
 *     the predicted spans together cover at least half of its characters; it
 *     is a partial find when they cover less than all of it. Otherwise it is
 *     MISSED.
 *   - A predicted span that overlaps no gold span is a FALSE ALARM.
 *   - A sentence WITHOUT gold (`gold` absent: "try your own text", not yet
 *     marked) is not scored: every find is reported as kind 'found' and the
 *     verdict is 'no_gold'. A sentence with `gold: []` (a near miss) IS
 *     scored: anything found in it is a false alarm.
 *
 * Coverage rather than one-to-one matching, because the shield redacts by
 * span: two adjacent predictions that together cover a customer number hide
 * it just as well as one. The ≥50% bar follows the guard's evaluation
 * (guard-service/eval/matcher.py, overlap mode at IoU 0.5); `partial` is kept
 * separately because a partly hidden value is a partly leaked value.
 */

/** Merge overlapping or touching spans into disjoint, sorted ones. */
function mergeSpans(spans) {
    const sorted = (Array.isArray(spans) ? spans : [])
        .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
        .map((s) => ({ start: s.start, end: s.end }))
        .sort((a, b) => a.start - b.start || a.end - b.end);
    const out = [];
    for (const s of sorted) {
        const last = out[out.length - 1];
        if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
        else out.push(s);
    }
    return out;
}

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

function coveredChars(gold, merged) {
    let n = 0;
    for (const p of merged) {
        n += Math.max(0, Math.min(gold.end, p.end) - Math.max(gold.start, p.start));
    }
    return n;
}

/**
 * @param {{ gold?: Array<{start:number,end:number}> }} sentence
 * @param {Array<{start:number,end:number}>} predicted
 * @returns {{ marks: Array<{start:number,end:number,kind:string,partial?:true}>, verdict: string,
 *             found: number, total: number, falseAlarms: number }}
 */
function scoreSentence(sentence, predicted) {
    const merged = mergeSpans(predicted);
    if (!Array.isArray(sentence?.gold)) {
        return {
            marks: merged.map((p) => ({ start: p.start, end: p.end, kind: 'found' })),
            verdict: 'no_gold',
            found: 0,
            total: 0,
            falseAlarms: 0,
        };
    }
    // Gold spans are disjoint by contract; they are not merged, so two marked
    // values that touch still count as two.
    const gold = sentence.gold
        .filter((g) => g && Number.isFinite(g.start) && Number.isFinite(g.end) && g.end > g.start)
        .map((g) => ({ start: g.start, end: g.end }))
        .sort((a, b) => a.start - b.start || a.end - b.end);
    const marks = [];
    let found = 0;
    for (const g of gold) {
        const covered = coveredChars(g, merged);
        const length = g.end - g.start;
        if (covered * 2 >= length) {
            found += 1;
            marks.push(covered < length ? { start: g.start, end: g.end, kind: 'hit', partial: true } : { start: g.start, end: g.end, kind: 'hit' });
        } else {
            marks.push({ start: g.start, end: g.end, kind: 'missed' });
        }
    }
    let falseAlarms = 0;
    for (const p of merged) {
        if (gold.some((g) => overlaps(g, p))) continue;
        falseAlarms += 1;
        marks.push({ start: p.start, end: p.end, kind: 'false_alarm' });
    }
    marks.sort((a, b) => a.start - b.start || a.end - b.end);
    const missed = gold.length - found;
    let verdict = 'correct';
    if (missed > 0 && falseAlarms > 0) verdict = 'mixed';
    else if (missed > 0) verdict = 'missed';
    else if (falseAlarms > 0) verdict = 'false_alarm';
    return { marks, verdict, found, total: gold.length, falseAlarms };
}

/** Totals over scored sentences: { found, total, falseAlarms, sentences }. */
function summarize(scored) {
    const list = Array.isArray(scored) ? scored : [];
    return list.reduce((acc, s) => ({
        found: acc.found + (s.found || 0),
        total: acc.total + (s.total || 0),
        falseAlarms: acc.falseAlarms + (s.falseAlarms || 0),
        sentences: acc.sentences + 1,
    }), { found: 0, total: 0, falseAlarms: 0, sentences: 0 });
}

/**
 * F-beta over a summary, beta 2 by default: recall weighs four times as much
 * as precision, because a missed value leaks and a false alarm only hides a
 * word too many. Precision counts false-alarm spans against found golds.
 */
function fScore(summary, beta = 2) {
    const tp = summary?.found || 0;
    if (tp === 0) return 0;
    const precision = tp / (tp + (summary.falseAlarms || 0));
    const recall = summary.total ? tp / summary.total : 0;
    if (precision === 0 && recall === 0) return 0;
    const b2 = beta * beta;
    return ((1 + b2) * precision * recall) / (b2 * precision + recall);
}

module.exports = { mergeSpans, scoreSentence, summarize, fScore };
