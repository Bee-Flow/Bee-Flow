const { escapeHtml } = require('../../../templates/exportTemplate');

/*
 * AI CONTENT MARKING (EU AI Act Art. 50(2)). When the caller passes a
 * `marking` object (compliance/marking.js resolveMarking — only for a document
 * that carries model output, and only when the org switched marking on), every
 * output path gets two things: a VISIBLE footer line ("Generated with AI —
 * <org>") and machine-readable METADATA (PDF Info dictionary / DOCX core
 * properties) saying the content is AI-generated, by which provider, when and
 * from which automation. Full C2PA provenance is out of scope; this is the
 * "marked in a machine-readable format and detectable as artificially
 * generated" the article asks of a deployer. The Chromium PDF gets its
 * metadata in a post-processing pass with pdf-lib; when that package cannot be
 * loaded the visible line still ships and the result says `metadata:false`.
 */
const AI_MARK_SUBJECT = 'AI-generated content — EU AI Act Art. 50(2)';

const AI_MARK_PRODUCER = 'Bee Flow';

/**
 * The print document: system fonts, no scripts, no external anything.
 *
 * Every rule here is about paper. `h1..h3` avoid a page break right after a
 * heading, tables repeat their header row, and long URLs wrap instead of
 * running off the right edge — all things that only show up once someone
 * prints a real twelve-page report.
 */
/** The footer text of a marking object, or '' — the one place the line is read out of it. */
function markingText(marking) {
    if (!marking || marking.enabled === false) return '';
    return String(marking.footer_text || '').trim();
}

/**
 * The visible marking line as body HTML: a trailing footer the browser prints
 * on the last page, Word keeps as the closing paragraph, and the reader of a
 * plain-text dump still sees. Empty when the document is not marked.
 */
function markingFooterHtml(marking) {
    const text = markingText(marking);
    return text ? `<footer class="ai-mark"><p class="ai-mark">${escapeHtml(text)}</p></footer>` : '';
}

/** The PDF keyword list every path writes — one spelling for the whole product. */
function markingKeywords(marking) {
    return [
        'AIGenerated=true',
        `AIProvider=${marking.provider || 'unknown'}`,
        `GeneratedAt=${marking.generated_at || new Date().toISOString()}`,
        `BeeFlowAutomation=${marking.automation_id || ''}`,
    ];
}

module.exports = { AI_MARK_SUBJECT, AI_MARK_PRODUCER, markingText, markingFooterHtml, markingKeywords };
