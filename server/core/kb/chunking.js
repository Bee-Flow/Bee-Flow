// @typecheck
/**
 * Structure-aware text chunking for the local KB pipeline (see
 * chunkPrimitives.js for the pieces it is built from).
 */

const { convertAllHtmlTablesToMarkdown } = require('../text/markdownCleanup');
const {
    CHUNK_SIZE,
    CHUNK_OVERLAP,
    CHUNK_SIZE_FLEX,
    estimateTokens,
    extractAtomicBlocks,
    splitIntoSections,
    splitLongSection,
    isTocChunk,
} = require('./chunkPrimitives');

/**
 * Chunk text into token-aware pieces with overlap.
 * Structure-aware: HTML tables, markdown tables, and code blocks are
 * extracted as atomic units so they are never split mid-element.
 *
 * Heading propagation: tracks the last-seen Markdown heading and prepends
 * it to every chunk, so chunks that contain tables or continuation text
 * become findable by their section heading (e.g. "## 3.2 Salarisschalen").
 *
 * @param {string} text — input text to chunk
 * @returns {Array<{chunk_id: number, text: string, token_count: number, chunk_type: string}>}
 */
function chunkText(text) {
    if (!text || !text.trim()) return [];

    // Phase 0: Convert any residual HTML tables → Markdown (defence-in-depth — input
    //           should already be clean from azureDocIntelligence.js, but this protects
    //           against content arriving from other sources like documentParser, URL fetch, etc.)
    text = convertAllHtmlTablesToMarkdown(text);

    // Phase 1: Extract atomic blocks (tables, code blocks) → placeholders
    const { cleaned, blocks } = extractAtomicBlocks(text);

    // Phase 2: Split into natural sections (headings, paragraphs)
    const rawSections = splitIntoSections(cleaned);

    // Phase 3: Restore atomic blocks into the section stream
    const sections = [];
    for (const section of rawSections) {
        const blockMatch = section.trim().match(/^__ATOMIC_BLOCK_(\d+)__$/);
        if (blockMatch) {
            // This section is an atomic block — restore original content
            sections.push(blocks[parseInt(blockMatch[1], 10)]);
        } else if (/__ATOMIC_BLOCK_\d+__/.test(section)) {
            // Section contains a mix of text and placeholder(s) — split them apart
            const parts = section.split(/(__ATOMIC_BLOCK_\d+__)/);
            for (const part of parts) {
                const innerMatch = part.match(/^__ATOMIC_BLOCK_(\d+)__$/);
                if (innerMatch) {
                    sections.push(blocks[parseInt(innerMatch[1], 10)]);
                } else if (part.trim()) {
                    sections.push(part);
                }
            }
        } else {
            sections.push(section);
        }
    }

    // Phase 4: Build chunks, respecting atomic block boundaries
    // ─── Heading Hierarchy Stack ────────────────────────────────────
    // Track the full heading hierarchy (# → ## → ### → etc.) so every
    // chunk gets a breadcrumb prefix like "# Chapter 3\n## 3.2 Salaris…"
    // This is "smart structural overlap" — gives embeddings full context
    // without wasting tokens on repeated prose.
    const chunks = [];
    let currentParts = [];
    let currentTokenCount = 0;
    let chunkId = 0;

    // headingStack[0] = last seen #, [1] = last seen ##, etc.
    const headingStack = new Array(6).fill('');

    /**
     * Parse a heading line and update the stack.
     * When a new heading at level N is seen, clear all deeper levels (N+1..6).
     */
    function updateHeadingStack(headingLine) {
        const match = headingLine.match(/^(#{1,6})\s+/);
        if (!match) return;
        const level = match[1].length - 1; // 0-indexed: # = 0, ## = 1, etc.
        headingStack[level] = headingLine.trim();
        // Clear deeper levels (a new ## resets ###, ####, etc.)
        for (let i = level + 1; i < 6; i++) headingStack[i] = '';
    }

    /**
     * Build the heading breadcrumb prefix from the current stack.
     * Returns the chain of active headings, e.g.:
     *   "# 3. Arbeidsvoorwaarden\n## 3.2 Salarisschalen"
     */
    function getHeadingBreadcrumb() {
        return headingStack.filter(h => h).join('\n');
    }

    /**
     * Prepend heading breadcrumb to text for structural context.
     * - If text has no headings: prepend full breadcrumb
     * - If text starts with heading level N: prepend only parent levels (1..N-1)
     */
    function prependBreadcrumb(text) {
        if (!text) return text;
        const firstHeadingMatch = text.match(/^(#{1,6})\s+/m);
        if (firstHeadingMatch) {
            // Text already has a heading — prepend only parent levels above it
            const textLevel = firstHeadingMatch[1].length - 1; // 0-indexed
            const parents = headingStack.slice(0, textLevel).filter(h => h);
            if (parents.length === 0) return text;
            return `${parents.join('\n')}\n\n${text}`;
        }
        // No heading in text — prepend full breadcrumb
        const breadcrumb = getHeadingBreadcrumb();
        if (!breadcrumb) return text;
        return `${breadcrumb}\n\n${text}`;
    }

    for (const section of sections) {
        const sectionTokens = estimateTokens(section);
        const isAtomicBlock = /<table[\s\S]*<\/table>/i.test(section) ||
                              /^```[\s\S]*```$/.test(section) ||
                              /^(\|[^\n]+\n){2,}/.test(section);

        // Track ALL headings in this section and update the hierarchy stack
        const headingMatches = section.match(/^#{1,6}\s+.+$/gm);
        if (headingMatches) {
            for (const h of headingMatches) {
                updateHeadingStack(h);
            }
        }

        // Atomic blocks up to CHUNK_SIZE_FLEX stay whole (even if > CHUNK_SIZE)
        if (isAtomicBlock && sectionTokens <= CHUNK_SIZE_FLEX) {
            // Check if the last buffered part is a short label/description
            // (e.g. "**Salarisschaal 2024-01**") that should stay with the table
            let labelPrefix = '';
            const MAX_LABEL_TOKENS = 100;
            if (currentParts.length > 0) {
                const lastPart = currentParts[currentParts.length - 1];
                const lastPartTokens = estimateTokens(lastPart);
                if (lastPartTokens <= MAX_LABEL_TOKENS && !/^#{1,6}\s+/m.test(lastPart)) {
                    // Short non-heading text — carry it forward as a label for this table
                    labelPrefix = lastPart.trim();
                    currentParts.pop();
                    currentTokenCount -= lastPartTokens;
                }
            }
            // Flush remaining buffer
            if (currentParts.length > 0) {
                const ct = currentParts.join('\n\n').trim();
                if (ct) {
                    chunks.push({ chunk_id: chunkId, text: ct, token_count: currentTokenCount });
                    chunkId++;
                }
                currentParts = [];
                currentTokenCount = 0;
            }
            // Emit the atomic block with heading breadcrumb + label prefix
            let atomicText = section.trim();
            if (labelPrefix) {
                atomicText = `${labelPrefix}\n\n${atomicText}`;
            }
            atomicText = prependBreadcrumb(atomicText);
            const atomicTokens = estimateTokens(atomicText);
            chunks.push({ chunk_id: chunkId, text: atomicText, token_count: atomicTokens });
            chunkId++;
            continue;
        }

        // If this single section exceeds chunk_size, split it further
        if (sectionTokens > CHUNK_SIZE) {
            // Flush current buffer first
            if (currentParts.length > 0) {
                const ct = currentParts.join('\n\n').trim();
                if (ct) {
                    chunks.push({ chunk_id: chunkId, text: ct, token_count: currentTokenCount });
                    chunkId++;
                }
                currentParts = [];
                currentTokenCount = 0;
            }

            // Split the long section (tables by row, text by sentence)
            const subParts = splitLongSection(section, CHUNK_SIZE);
            for (let spIdx = 0; spIdx < subParts.length; spIdx++) {
                let spText = subParts[spIdx].trim();
                // Prepend heading breadcrumb to continuation sub-parts
                if (spIdx > 0) {
                    spText = prependBreadcrumb(spText);
                }
                const spTokens = estimateTokens(spText);
                chunks.push({ chunk_id: chunkId, text: spText, token_count: spTokens });
                chunkId++;
            }
            continue;
        }

        // Check if adding this section exceeds chunk_size
        if (currentTokenCount + sectionTokens > CHUNK_SIZE) {
            // Flush current chunk
            let ct = currentParts.join('\n\n').trim();
            if (ct) {
                ct = prependBreadcrumb(ct);
                chunks.push({ chunk_id: chunkId, text: ct, token_count: estimateTokens(ct) });
                chunkId++;
            }
            // Sliding-window overlap: carry over trailing sections/sentences
            // that fit within the CHUNK_OVERLAP token budget
            if (currentParts.length > 0) {
                const overlapParts = [];
                let overlapTokens = 0;
                // Walk backwards through sections to gather overlap material
                for (let i = currentParts.length - 1; i >= 0; i--) {
                    const partTokens = estimateTokens(currentParts[i]);
                    if (partTokens > CHUNK_OVERLAP) {
                        // Section too large — extract trailing sentences instead
                        const sentences = currentParts[i].split(/(?<=[.!?])\s+/);
                        const tailSentences = [];
                        let tailTokens = 0;
                        for (let j = sentences.length - 1; j >= 0; j--) {
                            const sTokens = estimateTokens(sentences[j]);
                            if (tailTokens + sTokens > CHUNK_OVERLAP - overlapTokens) break;
                            tailSentences.unshift(sentences[j]);
                            tailTokens += sTokens;
                        }
                        if (tailSentences.length > 0) {
                            overlapParts.unshift(tailSentences.join(' '));
                            overlapTokens += tailTokens;
                        }
                        break; // Don't look further back
                    }
                    if (overlapTokens + partTokens > CHUNK_OVERLAP) break;
                    overlapParts.unshift(currentParts[i]);
                    overlapTokens += partTokens;
                }
                currentParts = overlapParts;
                currentTokenCount = overlapTokens;
            } else {
                currentParts = [];
                currentTokenCount = 0;
            }
        }

        currentParts.push(section);
        currentTokenCount += sectionTokens;
    }

    // Final chunk
    if (currentParts.length > 0) {
        let ct = currentParts.join('\n\n').trim();
        if (ct) {
            ct = prependBreadcrumb(ct);
            chunks.push({ chunk_id: chunkId, text: ct, token_count: estimateTokens(ct) });
        }
    }

    // Filter out tiny chunks (< 20 tokens)
    const MIN_TOKENS = 20;
    const filtered = chunks.filter(c => c.token_count >= MIN_TOKENS);

    // Tag chunk types (ToC, content)
    for (const chunk of filtered) {
        chunk.chunk_type = isTocChunk(chunk.text) ? 'toc' : 'content';
    }

    // Re-number chunk IDs
    filtered.forEach((c, i) => { c.chunk_id = i; });

    return filtered;
}

module.exports = { chunkText, estimateTokens };
