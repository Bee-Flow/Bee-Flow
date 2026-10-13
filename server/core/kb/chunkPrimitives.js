/**
 * The building blocks of the KB chunker: the token estimate, the atomic-block
 * extraction (tables, code) and the section / long-section / table-row
 * splitters. `chunking.js` strings them together.
 */

// ── Structure-aware text chunking ───────────────────────────────────

const CHUNK_SIZE = 400;    // tokens per chunk (sweet spot for text-embedding-3-small)
const CHUNK_OVERLAP = 60;  // token overlap (~15% — preserves boundary context)
const CHUNK_SIZE_FLEX = Math.floor(CHUNK_SIZE * 1.8); // atomic blocks up to this size stay whole

/**
 * Simple token counter based on character-length heuristic.
 * Calibrated for mixed Dutch/English content — Dutch words average
 * 5-6 chars but tokenize to ~3.5 chars/token with text-embedding-3-small.
 */
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 3.5);
}

/**
 * Extract structural blocks (HTML tables, markdown tables, fenced code blocks)
 * from text and replace them with placeholders. Returns the cleaned text and
 * a map of placeholder → original block.
 *
 * This ensures structural elements are treated as atomic units during chunking.
 */
function extractAtomicBlocks(text) {
    const blocks = [];
    let cleaned = text;

    // 1. HTML tables: <table...>...</table> (dotAll via [\s\S])
    cleaned = cleaned.replace(/<table[\s\S]*?<\/table>/gi, (match) => {
        const idx = blocks.length;
        blocks.push(match);
        return `\n\n__ATOMIC_BLOCK_${idx}__\n\n`;
    });

    // 2. Fenced code blocks: ```...```
    cleaned = cleaned.replace(/```[\s\S]*?```/g, (match) => {
        const idx = blocks.length;
        blocks.push(match);
        return `\n\n__ATOMIC_BLOCK_${idx}__\n\n`;
    });

    // 3. Markdown tables: consecutive lines starting with |
    cleaned = cleaned.replace(/((?:^|\n)\|[^\n]+\n(?:\|[^\n]+\n?){2,})/g, (match) => {
        const idx = blocks.length;
        blocks.push(match.trim());
        return `\n\n__ATOMIC_BLOCK_${idx}__\n\n`;
    });

    return { cleaned, blocks };
}

/**
 * Split an HTML table that exceeds CHUNK_SIZE into row-based sub-chunks.
 * Preserves <table>, <caption>, and <thead> as a header for each sub-chunk.
 */
function splitHtmlTableByRows(tableHtml, chunkSize) {
    // Extract table wrapper (opening <table> + <caption> + <thead>) and rows
    const headerMatch = tableHtml.match(/^(<table[^>]*>(?:\s*<caption[^>]*>[\s\S]*?<\/caption>)?(?:\s*<thead[\s\S]*?<\/thead>)?)/i);
    const tableHeader = headerMatch ? headerMatch[1] : '<table>';
    const tableFooter = '</table>';

    // Extract all <tr>...</tr> blocks from the tbody area
    const rows = [];
    const trRegex = /<tr[\s\S]*?<\/tr>/gi;
    let rowMatch;
    // Skip rows already in thead
    const bodyStart = tableHtml.indexOf('</thead>');
    const searchArea = bodyStart >= 0 ? tableHtml.slice(bodyStart) : tableHtml;
    while ((rowMatch = trRegex.exec(searchArea)) !== null) {
        rows.push(rowMatch[0]);
    }

    if (rows.length === 0) return [tableHtml]; // Can't split further

    const TABLE_ROW_OVERLAP = 2; // Repeat last N rows from previous chunk for context
    const subChunks = [];
    let currentRows = [];
    let currentSize = estimateTokens(tableHeader + tableFooter);

    for (const row of rows) {
        const rowTokens = estimateTokens(row);

        if (currentSize + rowTokens > chunkSize && currentRows.length > 0) {
            // Flush current sub-chunk
            subChunks.push(`${tableHeader}\n<tbody>\n${currentRows.join('\n')}\n</tbody>\n${tableFooter}`);
            // Keep last N rows as overlap for the next sub-chunk
            const overlapRows = currentRows.slice(-TABLE_ROW_OVERLAP);
            currentRows = [...overlapRows];
            currentSize = estimateTokens(tableHeader + tableFooter + overlapRows.join('\n'));
        }

        currentRows.push(row);
        currentSize += rowTokens;
    }

    // Final sub-chunk
    if (currentRows.length > 0) {
        subChunks.push(`${tableHeader}\n<tbody>\n${currentRows.join('\n')}\n</tbody>\n${tableFooter}`);
    }

    return subChunks.length > 0 ? subChunks : [tableHtml];
}

/**
 * Split text into natural sections at heading and paragraph boundaries.
 */
function splitIntoSections(text) {
    const parts = text.split(/(?=(?:^|\n)#{1,6}\s)|(?:\n\n)+/);
    return parts.filter(p => p && p.trim());
}

/**
 * Split a long section by sentence boundaries with sliding-window overlap.
 * Carries over as many trailing sentences as fit within CHUNK_OVERLAP budget.
 */
function splitLongSection(text, chunkSize) {
    // If this is an HTML table, split by rows instead of sentences
    if (/<table[\s\S]*<\/table>/i.test(text)) {
        return splitHtmlTableByRows(text, chunkSize);
    }

    const sentences = text.split(/(?<=[.!?])\s+/);
    const parts = [];
    let current = [];
    let currentCount = 0;

    for (const sentence of sentences) {
        const sentTokens = estimateTokens(sentence);

        if (currentCount + sentTokens > chunkSize && current.length > 0) {
            parts.push(current.join(' '));

            // Sliding-window overlap: carry back as many trailing sentences
            // as fit within the CHUNK_OVERLAP token budget
            const overlapSentences = [];
            let overlapTokens = 0;
            for (let i = current.length - 1; i >= 0; i--) {
                const sTokens = estimateTokens(current[i]);
                if (overlapTokens + sTokens > CHUNK_OVERLAP) break;
                overlapSentences.unshift(current[i]);
                overlapTokens += sTokens;
            }

            current = [...overlapSentences, sentence];
            currentCount = overlapTokens + sentTokens;
        } else {
            current.push(sentence);
            currentCount += sentTokens;
        }
    }

    if (current.length > 0) {
        parts.push(current.join(' '));
    }

    return parts.length > 0 ? parts : [text];
}

/**
 * Detect whether a chunk is a Table of Contents fragment.
 * ToC tables have rows like: | number | title | page_number |
 *
 * @param {string} text
 * @returns {boolean}
 */
function isTocChunk(text) {
    const lines = text.split('\n').filter(l => l.trim().startsWith('|'));
    if (lines.length < 3) return false;
    // Skip separator lines (| --- | --- |)
    const dataLines = lines.filter(l => !/^\|[\s-|]+\|$/.test(l.trim()));
    if (dataLines.length < 2) return false;
    // ToC pattern: most data rows have a number/section-ref, title, and page number
    const tocRows = dataLines.filter(l => /\|\s*[\d.]+\s*\|.*\|\s*\d+\s*\|/.test(l));
    return tocRows.length > dataLines.length * 0.4;
}

module.exports = {
    CHUNK_SIZE,
    CHUNK_OVERLAP,
    CHUNK_SIZE_FLEX,
    estimateTokens,
    extractAtomicBlocks,
    splitHtmlTableByRows,
    splitIntoSections,
    splitLongSection,
    isTocChunk,
};
