// @typecheck
/**
 * In-band <think> reasoning extraction (BFSF-263).
 *
 * Reasoning models served through generic OpenAI-compatible endpoints (Qwen3,
 * DeepSeek-R1 and distills via Ollama/vLLM/LM Studio/llama.cpp) emit their
 * chain-of-thought as literal <think>…</think> (or <thinking>…</thinking>)
 * text at the START of the assistant turn. Providers with typed thinking
 * events (Claude/OpenAI/Google/Mistral adapters) already separate reasoning;
 * these in-band tags used to pass through verbatim as visible chat text.
 *
 * createThinkTagSplitter — chunk-boundary-safe streaming splitter:
 *   - Detects an opening tag ONLY at the start of the turn (optional leading
 *     whitespace). Mid-content "<think>" (e.g. the user asked for a code
 *     example) is never treated as reasoning.
 *   - Buffers at most ~a tag's length of a potential partial tag, so
 *     streaming never stalls and no characters are dropped.
 *   - An unclosed <think> runs to end-of-stream as reasoning (flush()).
 *   - disableTagDetection() turns the splitter into a passthrough — used when
 *     the stream also carries delta.reasoning_content, so models that emit
 *     BOTH never produce doubled thinking.
 *
 * stripThinkTags / extractThinkBlocks — non-streaming + defensive variants:
 *   complete tag pairs anywhere, plus a LEADING unclosed block. Used for
 *   non-streaming responses and for cleaning persisted history.
 *
 * (Prior art: the deleted MiniMax adapter shipped a similar in-stream
 * splitter — git show 4bca69cc~1:server/core/providers/minimax.js.)
 */

// One family per reasoning syntax in the wild. `probe` is the shortest string
// that must appear before a close can start, so the scanner can hold back a
// partial close across chunk boundaries; `closes` are the endings accepted for
// a turn opened with that family (a model that opens <think> and closes
// </thinking> is common enough to allow).
//
// Gemma 4 is the reason this is a table rather than two constants: it does not
// use tags at all but a CHANNEL — `<|channel>thought … <channel|>` — and its
// template emits an EMPTY one to mean "thinking is off". Unextracted, every
// deliberation landed in the visible answer (2026-09-12: a builder turn showed
// the model arguing with itself for a page and drafting a tool call in prose).
const TAG_FAMILIES = [
    { opens: ['<thinking>', '<think>'], closes: ['</thinking>', '</think>'], probe: '</think' },
    { opens: ['<|channel>thought'], closes: ['<channel|>'], probe: '<channel|>' },
];
const OPEN_TAGS = TAG_FAMILIES.flatMap(f => f.opens).sort((a, b) => b.length - a.length);
const CLOSE_TAGS = TAG_FAMILIES.flatMap(f => f.closes).sort((a, b) => b.length - a.length);
const MAX_OPEN_LOOKAHEAD = OPEN_TAGS[0].length;
const MAX_CLOSE_LOOKAHEAD = CLOSE_TAGS[0].length;

function familyForOpen(tag) {
    return TAG_FAMILIES.find(f => f.opens.includes(tag)) || TAG_FAMILIES[0];
}

function isPrefixOfAny(s, tags) {
    return tags.some(tag => tag.startsWith(s));
}

function matchAny(s, tags) {
    return tags.find(tag => s.startsWith(tag)) || null;
}

function createThinkTagSplitter({ onText, onThinking, onThinkingStart, onThinkingStop }) {
    // phase: 'start' — deciding whether the turn opens with a think tag;
    //        'thinking' — inside a tag, scanning for the close;
    //        'text' — passthrough for the rest of the turn.
    let phase = 'start';
    let pending = '';
    let disabled = false;
    // Which syntax opened the current block, and whether a start was actually
    // announced. Gemma's "thinking off" marker is an EMPTY channel, so the
    // start is deferred until there is reasoning to show — otherwise every
    // non-thinking turn would open an empty Thinking… bubble.
    let family = TAG_FAMILIES[0];
    let announced = false;
    // Whitespace seen inside a block before any real reasoning. Held back
    // rather than emitted: Gemma's "thinking off" marker is `<|channel>thought
    // \n<channel|>`, and that newline would otherwise open a Thinking… bubble
    // containing one blank line on every non-thinking turn.
    let leadingWs = '';

    const announce = () => {
        if (!announced) { announced = true; onThinkingStart?.(); }
    };
    const finish = () => {
        leadingWs = '';
        if (announced) { announced = false; onThinkingStop?.(); }
    };

    const emitText = (s) => { if (s) onText(s); };
    const emitThinking = (s) => {
        if (!s) return;
        if (!announced) {
            if (!s.trim()) { leadingWs += s; return; }   // still nothing to show
            const withHeld = leadingWs + s;
            leadingWs = '';
            announce();
            onThinking(withHeld.replace(/^\s+/, ''));
            return;
        }
        onThinking(s);
    };

    function enterText(initial) {
        phase = 'text';
        emitText(initial);
    }

    function processStart() {
        // Decide on the leading run: whitespace then (maybe) an open tag.
        const trimmed = pending.replace(/^\s+/, '');
        if (trimmed === '') return; // still only whitespace — keep waiting
        if (trimmed[0] !== '<') {
            const buf = pending; pending = '';
            enterText(buf);
            return;
        }
        const open = matchAny(trimmed, OPEN_TAGS);
        if (open) {
            // Swallow the tag AND the insignificant leading whitespace — the
            // visible answer must not start with a stray blank paragraph, and
            // downstream "is there content yet?" checks rely on content
            // staying empty during the reasoning phase.
            pending = trimmed.slice(open.length);
            phase = 'thinking';
            family = familyForOpen(open);
            processThinking();
            return;
        }
        if (trimmed.length < MAX_OPEN_LOOKAHEAD && isPrefixOfAny(trimmed, OPEN_TAGS)) {
            return; // possible partial open tag split across chunks — wait
        }
        // Starts with '<' but is not (a prefix of) a think tag.
        const buf = pending; pending = '';
        enterText(buf);
    }

    function processThinking() {
        for (;;) {
            const idx = pending.indexOf(family.probe);
            if (idx === -1) {
                // Hold back a suffix that could be the start of a close tag.
                let hold = 0;
                const maxHold = Math.min(pending.length, MAX_CLOSE_LOOKAHEAD - 1);
                for (let len = maxHold; len > 0; len--) {
                    if (isPrefixOfAny(pending.slice(pending.length - len), family.closes)) { hold = len; break; }
                }
                emitThinking(pending.slice(0, pending.length - hold));
                pending = hold ? pending.slice(pending.length - hold) : '';
                return;
            }
            emitThinking(pending.slice(0, idx));
            pending = pending.slice(idx);
            const close = matchAny(pending, family.closes);
            if (close) {
                pending = pending.slice(close.length);
                finish();
                // An empty block (Gemma's "thinking is off" marker, or a bare
                // <think></think>) announced nothing, so nothing is closed and
                // the turn simply continues as text.
                const rest = pending; pending = '';
                enterText(rest);
                return;
            }
            if (isPrefixOfAny(pending, family.closes)) return; // partial close tag — wait
            // The probe matched but the full close did not (e.g. '</thinker') —
            // it's reasoning content. Emit the '<' and rescan.
            emitThinking(pending[0]);
            pending = pending.slice(1);
        }
    }

    return {
        push(text) {
            if (text === undefined || text === null || text === '') return;
            if (disabled || phase === 'text') { emitText(String(text)); return; }
            pending += String(text);
            if (phase === 'start') processStart();
            else if (phase === 'thinking') processThinking();
        },
        // Stream also carries typed reasoning (delta.reasoning_content) —
        // never double-extract. Anything buffered so far is visible text.
        disableTagDetection() {
            if (disabled) return;
            disabled = true;
            if (phase === 'thinking') { finish(); }
            const buf = pending; pending = '';
            phase = 'text';
            emitText(buf);
        },
        flush() {
            if (phase === 'start' && pending) {
                // Turn ended while we were still deciding — it was plain text.
                const buf = pending; pending = '';
                enterText(buf);
            } else if (phase === 'thinking') {
                // Unclosed block — everything to end-of-stream was reasoning.
                emitThinking(pending);
                pending = '';
                phase = 'text';
                finish();
            }
        },
    };
}

// ── Non-streaming / defensive helpers ───────────────────────────────

const PAIR_RE = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
const LEADING_UNCLOSED_RE = /^\s*<think(?:ing)?>([\s\S]*)$/i;
// Gemma 4's channel form, for the same two jobs (non-streaming replies and
// cleaning persisted history). Kept as its own pair: the syntaxes share no
// characters, and one regex for both would be unreadable.
const CHANNEL_PAIR_RE = /<\|channel>thought([\s\S]*?)<channel\|>/g;
const CHANNEL_LEADING_UNCLOSED_RE = /^\s*<\|channel>thought([\s\S]*)$/;

/**
 * Split complete <think> pairs (anywhere) and a leading unclosed block out of
 * a full text. Returns { content, thinking } — thinking is null when nothing
 * was extracted, content keeps its original shape otherwise.
 */
function extractThinkBlocks(text) {
    if (typeof text !== 'string' || (text.indexOf('<think') === -1 && text.indexOf('<|channel>thought') === -1)) {
        return { content: text, thinking: null };
    }
    const thinkingParts = [];
    let content = text.replace(PAIR_RE, (_, inner) => {
        thinkingParts.push(inner);
        return '';
    }).replace(CHANNEL_PAIR_RE, (_, inner) => {
        thinkingParts.push(inner);
        return '';
    });
    // A LEADING unclosed tag (reasoning ran to end-of-message — truncated or
    // the model never closed it). Mid-content unclosed tags are left alone:
    // they're more likely literal text the user asked about.
    const leading = content.match(LEADING_UNCLOSED_RE) || content.match(CHANNEL_LEADING_UNCLOSED_RE);
    if (leading) {
        thinkingParts.push(leading[1]);
        content = '';
    }
    // Every block was empty (Gemma's "thinking is off" marker): the markers are
    // gone from the content, but there is no reasoning to report.
    if (thinkingParts.length === 0) return { content: text, thinking: null };
    return {
        content: content.replace(/^\s+/, ''),
        thinking: thinkingParts.join('\n').trim() || null,
    };
}

function stripThinkTags(text) {
    return extractThinkBlocks(text).content;
}

module.exports = { createThinkTagSplitter, extractThinkBlocks, stripThinkTags };
