// @typecheck
/**
 * R3: cheap, deterministic topic extraction from a schedule result, for the
 * schedule's coverage memory (core/aiTaskRunner.js writes it, the agent's
 * context builder reads it back as "previously covered").
 *
 * Looks for markdown headings (### Topic) and numbered list items (1) Topic —
 * summary) — the two patterns the wizard's schedules tend to emit, plus
 * bold-led bullets.
 *
 * Returns `[{ subject, title, summary }]`. `subject` is a stable slug used
 * as the dedupe key across runs.
 */

function _slugify(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}

function extractCoverageTopics(text) {
    if (!text || typeof text !== 'string') return [];
    const out = [];
    const seen = new Set();
    const push = (title, summary) => {
        const cleanTitle = String(title).replace(/\*\*|__|\[|\]\(.*?\)/g, '').trim();
        if (cleanTitle.length < 4 || cleanTitle.length > 200) return;
        const subject = _slugify(cleanTitle);
        if (!subject || seen.has(subject)) return;
        seen.add(subject);
        out.push({ subject, title: cleanTitle, summary: summary ? String(summary).trim().slice(0, 280) : null });
    };

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        // Numbered item:  "1) Title — summary"  or  "1. Title: summary"
        const numbered = line.match(/^\s*\d+[\.\)]\s+(.+?)(?:\s*[—:\-]\s+(.*))?$/);
        if (numbered) { push(numbered[1], numbered[2] || lines[i + 1]); continue; }
        // Bold-led bullet:  "**Title** — summary"
        const boldBullet = line.match(/^\s*[-*]\s+\*\*(.+?)\*\*\s*[—:\-]\s+(.+)$/);
        if (boldBullet) { push(boldBullet[1], boldBullet[2]); continue; }
        // Markdown heading at level 3+ (level 1/2 tend to be section names like "Beleid & defensie")
        const heading = line.match(/^\s*#{3,6}\s+(.+?)\s*$/);
        if (heading) { push(heading[1], lines[i + 1]); continue; }
    }
    return out;
}

module.exports = { extractCoverageTopics };
