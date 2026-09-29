/**
 * The light markdown the builder's reasoning actually uses.
 *
 * A local model reasons in markdown by habit, and the panel rendered it as
 * `whitespace-pre-wrap` text — so a plan came out as a wall of literal
 * backticks and hyphens. This turns the four shapes that actually occur into
 * elements: inline `code`, `-`/`*` bullets, `1.` numbered lists, and
 * bold/italic.
 *
 * DELIBERATELY NOT MarkdownRenderer. That one pulls in KaTeX, highlight.js,
 * Mermaid and a dozen custom block renderers — a large parse on text that
 * arrives a token at a time and is re-rendered on every one of them. None of
 * its features appear in reasoning text. This is a character scanner emitting
 * React elements only, so the output is escaped by construction: no regex on
 * untrusted text, no dangerouslySetInnerHTML.
 *
 * STREAMING IS THE HARD CASE, and it is why the marker handling looks
 * cautious. Half a token is a normal state here: a lone "`" that has not met
 * its partner yet, a "**" mid-word. Every marker therefore requires its
 * closing partner ON THE SAME LINE before it means anything; unmatched
 * markers stay literal text. Without that rule a single opening backtick
 * swallows the rest of the paragraph on every keystroke until it closes, and
 * the block flickers between two readings of the same sentence.
 *
 * ORDER MATTERS: code spans are found before emphasis. `0 8 * * 1-5` is a real
 * cron expression the builder reasons about constantly, and its two asterisks
 * are italic markers to any parser that looks at emphasis first.
 *
 * TWO THINGS THE 2026-09-13 TRACE TAUGHT (Gemma 4 wrote a tool call as text
 * inside its thought channel, and the block showed "appuserttable" in italic
 * with raw <|"> tokens between the words):
 *   - an underscore INSIDE a word is never emphasis (CommonMark's rule; tool
 *     and field names are snake_case and appear in every reasoning line);
 *   - a call in a model's wire syntax — `<|tool_call>call:NAME{…}<tool_call|>`
 *     (Gemma) or `<tool_call>{…}</tool_call>` (Hermes/Qwen) — is rendered as
 *     one code block, tokens stripped, `<|">` fences shown as quotes, even
 *     while it is still being typed. The server runs the call
 *     (core/llm/leakedToolCalls); this only keeps the picture honest.
 */

import React from 'react';

// The wire syntaxes a call-as-text arrives in: [open, close]. Kept in step
// with server/core/llm/leakedToolCalls.js.
const CALL_SYNTAXES = [
    ['<|tool_call>', '<tool_call|>'],
    ['<tool_call>', '</tool_call>'],
];
const GEMMA_STRING_FENCE = '<|">';

/**
 * Split reasoning text into prose and call spans.
 * @returns {Array<{kind:'text',text:string}|{kind:'call',text:string,closed:boolean}>}
 */
export function splitCallSpans(text) {
    const src = typeof text === 'string' ? text : '';
    const out = [];
    let pos = 0;
    while (pos < src.length) {
        let best = null;
        for (const [open, close] of CALL_SYNTAXES) {
            const at = src.indexOf(open, pos);
            if (at !== -1 && (!best || at < best.at)) best = { at, open, close };
        }
        if (!best) break;
        if (best.at > pos) out.push({ kind: 'text', text: src.slice(pos, best.at) });
        const closeAt = src.indexOf(best.close, best.at + best.open.length);
        const end = closeAt === -1 ? src.length : closeAt + best.close.length;
        out.push({ kind: 'call', text: src.slice(best.at, end), closed: closeAt !== -1 });
        pos = end;
    }
    if (pos < src.length) out.push({ kind: 'text', text: src.slice(pos) });
    return out;
}

/** The tool name a call span carries, or '' while it is not typed yet. */
export function callSpanName(span) {
    const text = span && span.text ? span.text : '';
    const gemma = /call:\s*([A-Za-z_][\w.-]*)/.exec(text);
    if (gemma) return gemma[1];
    const hermes = /"name"\s*:\s*"([^"]+)"/.exec(text);
    return hermes ? hermes[1] : '';
}

/** The call as a person reads it: tokens gone, fences as quotes, name first. */
function prettyCall(span) {
    let body = span.text;
    for (const [open, close] of CALL_SYNTAXES) {
        if (body.startsWith(open)) body = body.slice(open.length);
        if (span.closed && body.endsWith(close)) body = body.slice(0, -close.length);
    }
    body = body.split(GEMMA_STRING_FENCE).join('"').trim().replace(/^call:\s*/, '');
    return `→ ${body}`;
}

/**
 * An underscore between word characters is part of the word —
 * `app_upsert_table`, `contact_person` — never an emphasis marker (CommonMark).
 * Either end of the would-be span touching a word character disqualifies it.
 */
function intraWordUnderscore(text, open, close, marker) {
    if (marker[0] !== '_') return false;
    if (open > 0 && /\w/.test(text[open - 1])) return true;
    return close !== -1 && /\w/.test(text[close + marker.length] || '');
}

/** Inline spans of one line: code, bold, italic. Everything else is text. */
function inline(text, keyPrefix) {
    const out = [];
    let buf = '';
    let i = 0;
    const flush = () => { if (buf) { out.push(buf); buf = ''; } };

    while (i < text.length) {
        const ch = text[i];

        // `code` — first, so markers inside a span are never read as emphasis.
        if (ch === '`') {
            const close = text.indexOf('`', i + 1);
            const inner = close === -1 ? '' : text.slice(i + 1, close);
            if (inner) {
                flush();
                out.push(
                    <code
                        key={`${keyPrefix}-c${i}`}
                        className="px-1 py-px rounded font-mono text-[11px]"
                        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                    >
                        {inner}
                    </code>,
                );
                i = close + 1;
                continue;
            }
            buf += ch; i += 1; continue;
        }

        if (ch === '*' || ch === '_') {
            const bold = text[i + 1] === ch;
            const marker = bold ? ch + ch : ch;
            const close = text.indexOf(marker, i + marker.length);
            const inner = close === -1 ? '' : text.slice(i + marker.length, close);
            // A marker with nothing but spaces after it is punctuation, not
            // emphasis — "a * b" and a bare "**" mid-stream both land here.
            if (inner.trim() && !intraWordUnderscore(text, i, close, marker)) {
                flush();
                const key = `${keyPrefix}-e${i}`;
                const kids = inline(inner, key);
                out.push(bold ? <strong key={key}>{kids}</strong> : <em key={key}>{kids}</em>);
                i = close + marker.length;
                continue;
            }
            buf += ch; i += 1; continue;
        }

        buf += ch; i += 1;
    }
    flush();
    return out;
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBER = /^\s*(\d{1,3})[.)]\s+(.*)$/;

/**
 * Group lines into paragraphs, bullet lists and numbered lists.
 * @returns {Array<React.ReactNode>}
 */
export function renderThinking(text) {
    const src = typeof text === 'string' ? text : '';
    if (!src.trim()) return null;

    const blocks = [];
    for (const span of splitCallSpans(src)) {
        if (span.kind === 'call') {
            blocks.push(
                <pre
                    key={`call${blocks.length}`}
                    data-thinking-call={callSpanName(span) || 'partial'}
                    className="mb-1.5 last:mb-0 rounded px-2 py-1 font-mono text-[11px] whitespace-pre-wrap break-all"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                >
                    {prettyCall(span)}
                </pre>,
            );
        } else {
            renderProse(span.text, blocks);
        }
    }
    return blocks;
}

/** Paragraphs, bullet lists and numbered lists of one prose span → `blocks`. */
function renderProse(src, blocks) {
    const lines = src.split('\n');
    let para = [];
    let list = null;         // { ordered: boolean, items: string[] }

    const closePara = () => {
        if (!para.length) return;
        const key = `p${blocks.length}`;
        blocks.push(<p key={key} className="mb-1.5 last:mb-0">{inline(para.join(' '), key)}</p>);
        para = [];
    };
    const closeList = () => {
        if (!list) return;
        const key = `l${blocks.length}`;
        const Tag = list.ordered ? 'ol' : 'ul';
        blocks.push(
            <Tag
                key={key}
                className={`mb-1.5 last:mb-0 pl-4 ${list.ordered ? 'list-decimal' : 'list-disc'}`}
            >
                {list.items.map((item, n) => (
                    <li key={n} className="mb-0.5 last:mb-0">{inline(item, `${key}-${n}`)}</li>
                ))}
            </Tag>,
        );
        list = null;
    };

    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim()) { closePara(); closeList(); continue; }

        const num = NUMBER.exec(line);
        const bul = num ? null : BULLET.exec(line);
        if (num || bul) {
            closePara();
            const ordered = !!num;
            // A list that switches marker style is two lists, not one — the
            // reasoning does exactly this when it moves from a plan to a
            // checklist and the numbering would otherwise continue wrongly.
            if (list && list.ordered !== ordered) closeList();
            if (!list) list = { ordered, items: [] };
            list.items.push(num ? num[2] : bul[1]);
            continue;
        }

        closeList();
        para.push(line.trim());
    }
    closePara();
    closeList();
}

export default renderThinking;

/**
 * The one line worth showing while the block is shut.
 *
 * The panel says "Thinking…" and nothing else for as long as the model
 * reasons, which on a local model is most of the build. The obvious fix is to
 * have a small model summarise the stream — but there is no small model on
 * this machine (the fast tier resolves to the same 35B) and llama-server runs
 * `n_slots = 1`, so a summary request would queue against the very build it is
 * describing and make it slower.
 *
 * It also is not needed. Reasoning text announces itself in short declarative
 * lines — "Let's break it down:", "First, trigger.", "Wait, the HTTP request
 * might fail. I need to wire an error branch." — so the LAST such line already
 * is the summary, free and instantly, with no second model and no queue.
 *
 * Skips fragments a half-streamed line produces, and prose so short it says
 * nothing ("Yes.", "Wait,"), walking back until it finds a line that carries
 * an actual clause.
 */
export function currentThought(text, maxLen = 72) {
    const spans = splitCallSpans(typeof text === 'string' ? text : '');
    if (!spans.length) return '';
    // A call being written out IS what the model is doing right now — and its
    // syntax would otherwise read as a line of tokens. Name the tool.
    const last = spans[spans.length - 1];
    if (last.kind === 'call') {
        const name = callSpanName(last);
        return name ? `→ ${name}` : '→ …';
    }
    const src = spans.filter((s) => s.kind === 'text').map((s) => s.text).join('\n');
    if (!src.trim()) return '';
    const lines = src.split('\n');
    for (let i = lines.length - 1; i >= 0 && i > lines.length - 14; i--) {
        const bare = lines[i]
            .replace(/^\s*[-*+]\s+/, '')
            .replace(/^\s*\d{1,3}[.)]\s+/, '')
            .replace(/[`*_]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (bare.split(' ').filter(Boolean).length < 3) continue;
        if (bare.length <= maxLen) return bare;
        // Cut on a word boundary: a summary sliced mid-word reads as a bug.
        const cut = bare.slice(0, maxLen);
        const sp = cut.lastIndexOf(' ');
        return `${(sp > maxLen * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
    }
    return '';
}
