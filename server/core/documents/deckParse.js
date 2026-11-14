// @typecheck
const { DECK_LIMITS, DeckError, stripInlineMarkdown, clampText } = require('./deckBase');
const { parseSlideLines } = require('./deckParseLines');
const { slideFromFields, joinBody } = require('./deckSlideAssembly');

const RE_H1 = /^#\s+(.*)$/;

const RE_H2 = /^##\s+(.*)$/;

const RE_HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/** Turn a heading-free, line-based markdown fragment into slide fields (used for JSON `content` too). */
function fieldsFromContent(content) {
    const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n');
    return parseSlideLines(lines);
}

function deckFromMarkdown(markdown, warnings) {
    const md = String(markdown ?? '').replace(/\r\n?/g, '\n');
    if (md.length > DECK_LIMITS.maxMarkdownChars) {
        throw new DeckError(`The outline is ${md.length} characters; the limit is ${DECK_LIMITS.maxMarkdownChars}.`, 'deck_too_large');
    }
    const lines = md.split('\n');
    const deck = { title: '', subtitle: null, author: null, date: null, slides: [] };

    // Slice into [cover lines, {title, lines}...] on h2 (and on --- / a second h1).
    let cover = [];
    const sections = [];
    let cur = null;
    let pendingBreak = false;
    for (const line of lines) {
        let m;
        if ((m = RE_H1.exec(line)) && !deck.title && !cur) { deck.title = stripInlineMarkdown(m[1]); continue; }
        if ((m = RE_H2.exec(line)) || ((m = RE_H1.exec(line)) && (deck.title || cur))) {
            cur = { title: m[1], lines: [] };
            sections.push(cur);
            pendingBreak = false;
            continue;
        }
        if (RE_HR.test(line)) { pendingBreak = true; continue; }
        if (pendingBreak && line.trim()) {
            cur = { title: '', lines: [] };
            sections.push(cur);
            pendingBreak = false;
        }
        (cur ? cur.lines : cover).push(line);
    }

    // Cover material: the first paragraph is the subtitle; the rest is an intro slide.
    const coverFields = parseSlideLines(cover);
    const coverBody = joinBody(coverFields.body);
    if (coverBody) {
        const paras = coverBody.split(/\n{2,}/);
        deck.subtitle = clampText(paras.shift(), DECK_LIMITS.maxSubtitleChars, warnings, 'the subtitle');
        coverFields.body = paras.join('\n\n').split('\n');
    }
    if (coverFields.notes.length) {
        // Notes before the first slide belong to the cover; officegen puts
        // them on the cover slide.
        deck.coverNotes = coverFields.notes.join('\n');
    }
    const introHas = coverFields.bullets.length || joinBody(coverFields.body) || coverFields.table || coverFields.quote || coverFields.image;
    if (introHas) {
        deck.slides.push(slideFromFields(deck.title, coverFields, { warnings }));
    }

    for (const s of sections) {
        const f = parseSlideLines(s.lines);
        deck.slides.push(slideFromFields(s.title, f, { warnings }));
    }
    return deck;
}

module.exports = { parseSlideLines, fieldsFromContent, slideFromFields, deckFromMarkdown };
