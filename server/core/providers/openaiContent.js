// @typecheck
/**
 * Content-part translation for the OpenAI and Azure OpenAI adapters.
 *
 * Messages reach the adapter in the shape the rest of the platform builds:
 * mostly OpenAI Chat Completions parts (`text`, `image_url`), but a history can
 * also carry parts written for another provider — Claude's `document` (a native
 * PDF) and `image` (base64 source) blocks, or `cache_control` breakpoints — when
 * a conversation switches model. Both OpenAI APIs answer an unknown part type
 * or an unknown key on a part with a 400 that fails the WHOLE request, and
 * because the part stays in history the conversation never recovers. So every
 * part is rebuilt from an allow-list of fields for the API it is going to,
 * never forwarded as-is.
 *
 *   Responses:         input_text | input_image | input_file   (user/developer)
 *                      output_text                             (assistant)
 *   Chat Completions:  text | image_url | file
 */

const log = require('../../telemetry/log');

/** `image_url` is either a bare string or `{ url, detail }`. */
function _imageUrlOf(part) {
    const img = part.image_url;
    if (typeof img === 'string') return { url: img, detail: undefined };
    return { url: img?.url || '', detail: img?.detail };
}

/** Claude-shaped `{ type:'image', source:{ type:'base64', media_type, data } }` → data URL. */
function _claudeImageDataUrl(part) {
    const src = part.source;
    if (src?.type === 'base64' && src.data) return `data:${src.media_type || 'image/png'};base64,${src.data}`;
    if (src?.type === 'url' && src.url) return src.url;
    return null;
}

/**
 * A file part as `{ filename, dataUrl }`, from Claude's `document` block or an
 * already OpenAI-shaped `file` / `input_file` part. null → not a file we can send.
 */
function _fileOf(part) {
    if (part.type === 'document') {
        const src = part.source;
        if (src?.type !== 'base64' || !src.data) return null;
        return {
            filename: part.title || part.filename || 'document.pdf',
            dataUrl: `data:${src.media_type || 'application/pdf'};base64,${src.data}`,
        };
    }
    if (part.type === 'file' && part.file?.file_data) {
        return { filename: part.file.filename || 'document.pdf', dataUrl: part.file.file_data };
    }
    if (part.type === 'input_file' && part.file_data) {
        return { filename: part.filename || 'document.pdf', dataUrl: part.file_data };
    }
    return null;
}

/** Plain text of a part, for the parts that carry nothing but text. */
function _textOf(part) {
    if (['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string') return part.text;
    return null;
}

// Claude-only parts with no OpenAI counterpart. Tool round trips travel as
// `tool_calls` / role:'tool' messages here, and reasoning travels as
// `reasoningItems`, so dropping these loses nothing the model can use.
const SILENTLY_DROPPED = new Set(['thinking', 'redacted_thinking', 'tool_use', 'tool_result']);

function _drop(part, api) {
    if (!SILENTLY_DROPPED.has(part?.type)) {
        log.warn(`[OpenAIContent] Dropping a '${part?.type}' content part the ${api} API does not accept`);
    }
    return null;
}

/**
 * One part for a Responses `input` message. Returns null for a part that has
 * to go. `role` is the Responses role ('developer' | 'user' | 'assistant').
 */
function toResponsesPart(part, role) {
    if (!part || typeof part !== 'object') return null;

    const text = _textOf(part);
    if (text !== null) {
        // The assistant's own turns are output, and the API rejects input_text there.
        return role === 'assistant' ? { type: 'output_text', text } : { type: 'input_text', text };
    }
    if (role === 'assistant') return _drop(part, 'Responses (assistant)');

    if (part.type === 'image_url' || part.type === 'input_image') {
        const { url, detail } = part.type === 'input_image'
            ? { url: part.image_url || '', detail: part.detail }
            : _imageUrlOf(part);
        if (!url) return _drop(part, 'Responses');
        // `detail` is REQUIRED on a Responses input_image, unlike the Chat
        // Completions image_url block where it is optional.
        return { type: 'input_image', image_url: url, detail: detail || 'auto' };
    }
    if (part.type === 'image') {
        const url = _claudeImageDataUrl(part);
        return url ? { type: 'input_image', image_url: url, detail: 'auto' } : _drop(part, 'Responses');
    }
    const file = _fileOf(part);
    if (file) return { type: 'input_file', filename: file.filename, file_data: file.dataUrl };

    return _drop(part, 'Responses');
}

/**
 * A message's content for Chat Completions. Strings pass through; arrays are
 * rebuilt part by part. Returns the original array when nothing changed, so
 * stripInternalFields' identity check keeps untouched messages as they are.
 */
function toCompletionsContent(content, role) {
    if (!Array.isArray(content)) return content;

    const out = [];
    let changed = false;
    const push = (original, built) => {
        if (built === original) { out.push(original); return; }
        changed = true;
        if (built) out.push(built);
    };

    for (const part of content) {
        if (!part || typeof part !== 'object') { changed = true; continue; }
        push(part, _completionsPart(part, role));
    }
    return changed ? out : content;
}

/** Keys a part may carry on the wire; anything else (cache_control, …) is a 400. */
function _onlyKeys(obj, allowed) {
    return Object.keys(obj).every(k => allowed.includes(k));
}

/** One Chat Completions part: the original when it is already clean, a rebuilt one, or null. */
function _completionsPart(part, role) {
    const text = _textOf(part);
    if (text !== null) {
        return part.type === 'text' && _onlyKeys(part, ['type', 'text']) ? part : { type: 'text', text };
    }
    // Assistant messages take text (and refusal) parts only.
    if (role === 'assistant') return _drop(part, 'Chat Completions (assistant)');

    if (part.type === 'image_url' || part.type === 'input_image') {
        const { url, detail } = part.type === 'input_image'
            ? { url: part.image_url || '', detail: part.detail }
            : _imageUrlOf(part);
        if (!url) return _drop(part, 'Chat Completions');
        const clean = part.type === 'image_url' && _onlyKeys(part, ['type', 'image_url'])
            && typeof part.image_url === 'object' && _onlyKeys(part.image_url, ['url', 'detail']);
        return clean ? part : { type: 'image_url', image_url: detail ? { url, detail } : { url } };
    }
    if (part.type === 'image') {
        const url = _claudeImageDataUrl(part);
        return url ? { type: 'image_url', image_url: { url } } : _drop(part, 'Chat Completions');
    }
    const file = _fileOf(part);
    if (file) return { type: 'file', file: { filename: file.filename, file_data: file.dataUrl } };

    return _drop(part, 'Chat Completions');
}

module.exports = { toResponsesPart, toCompletionsContent };
