/**
 * Voice Chat Routes (Beta) — Realtime voice conversation with Mistral.
 *
 * Endpoints (all gated on the `voice_chat` beta feature + a configured
 * Mistral API key):
 *   GET  /ai/voice/availability           — cheap capability probe for the UI
 *   POST /ai/voice/session                — create a session, return defaults
 *   POST /ai/voice/turn                   — multipart audio in, SSE response out
 *
 * Per-turn pipeline:
 *   1. Receive the user's audio blob (MediaRecorder → audio/webm;opus).
 *   2. Voxtral STT → transcript (emitted as SSE `transcript`).
 *   3. Tool-calling loop (up to MAX_VOICE_TOOL_ROUNDS):
 *        Mistral stream with tools → emit `text` deltas.
 *        If the model emits tool_use, execute via the unified dispatcher,
 *        emit `tool_use` + `tool_result` SSE events, feed the result back
 *        into the messages array, and stream again.
 *   4. Voxtral TTS (fallback ElevenLabs) on the final reply → `tts` event
 *      with base64-encoded MP3.
 *   5. `done` event terminates the stream.
 *
 * Destructive tool calls are gated via a DRAFT_FIRST directive in the
 * system prompt — the model must announce its intent and wait for a spoken
 * confirmation before executing anything that creates, sends, modifies, or
 * deletes. No runtime enforcement: Mistral Large 3 follows this reliably
 * and a visual approval UI makes no sense in a voice flow.
 *
 * State is held client-side: the client sends `history` with each turn and
 * appends the assistant reply locally. This keeps v1 stateless and avoids
 * a schema migration for the Beta.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * `/session` takes a JSON body; `/turn` is multipart, so its schema sits
 * BEHIND multer, which is what puts the text fields on `req.body`. Both are
 * `.strict()`, and everything a turn can refuse is refused before the stream
 * opens, as JSON with a status — a missing recording used to be an `error`
 * event inside a 200, and a file of the wrong type or size a bare 500.
 *
 * AN AGENT IS CHECKED BEFORE IT IS USED. Both routes took any `agentId` and
 * loaded it with no access check: `/session` answered with that agent's
 * system prompt and name — any agent, of any organisation, unpublished ones
 * included — and `/turn` ran with its tool set and config. The agent now has
 * to pass the same audience rule as everywhere else (auth/audience: owner,
 * or published to the caller's org and groups — plus the agent library's
 * rule that someone in no org may use a published agent that is in none,
 * and the agent chat's rule that a draft is its owner's alone); an agent
 * that does not answers 404, the same as one that does not exist.
 *
 * What else the old reads let through, each under a 200:
 *   - a `history` field that was not valid JSON became [] — the whole
 *     conversation's context dropped without a word (mobile/.../voice/api.ts
 *     warns about exactly this); it is a 400 now;
 *   - `history` entries were spread into the model call verbatim, any role
 *     and any key. Only user and assistant turns, as { role, content }, go
 *     to the model now — an allow-list, like every other outbound payload.
 */

const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const log = require('../../telemetry/log');
const router = express.Router();
const { validate } = require('../../core/http/validate');
const { canSeePublished, resolveAudienceContext } = require('../../auth/audience');

const configStore = require('../../stores/configStore');
const { getAdapter } = require('../../core/providers');
const voxtralStt = require('../../core/voice/voxtralStt');
const voxtralTts = require('../../core/voice/voxtralTts');
const { getIntegrationTools, buildToolHint } = require('../../core/integrations/integrationTools');
const { executeTool: dispatchTool } = require('../../core/tools/toolDispatcher');
const agentStore = require('../../stores/agentStore');

// ─── Auth & gating ───────────────────────────────────────────────
// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../auth/permissions');

async function requireMistralConfigured(req, res, next) {
    const key = await configStore.getSecret('mistral_api_key');
    if (!key) {
        return res.status(409).json({
            error: 'mistral_not_configured',
            message: 'Voice chat requires a configured Mistral API key. Please add one in Admin → AI Config.',
        });
    }
    req._mistralKey = key;
    next();
}

// Memory-based multer — audio turns are small (~MBs) and we immediately
// hand the buffer to Voxtral; no need to touch disk.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const uploadTurn = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AUDIO_BYTES },
    fileFilter: (req, file, cb) => {
        if (file.mimetype?.startsWith('audio/')) cb(null, true);
        else cb(new Error('Only audio/* mimetypes are accepted'));
    },
});

/** multer, with its refusals answered as what they are instead of a 500. */
function receiveTurnAudio(req, res, next) {
    uploadTurn.single('audio')(req, res, (err) => {
        if (!err) return next();
        const tooBig = err.code === 'LIMIT_FILE_SIZE';
        return res.status(tooBig ? 413 : 400).json({
            error: tooBig
                ? `That recording is too large (max ${MAX_AUDIO_BYTES / 1024 / 1024} MB). Try a shorter question.`
                : (err.message || 'Upload rejected'),
            code: tooBig ? 'recording_too_large' : 'bad_upload',
        });
    });
}

// ─── What a caller may send ───────────────────────────────────────
/** A request that is not JSON / multipart at all reaches here with no body. */
const orEmpty = (schema) => z.preprocess((v) => (v === undefined || v === null ? {} : v), schema);
const AGENT_TEXT = 'agentId is the id of an agent you can use.';
const VOICE_TEXT = 'voice is the name of a voice.';
const LANGUAGE_TEXT = 'language is a language code, like nl or en.';
const HISTORY_TEXT = 'history is a JSON list of { role, content } messages.';
const boundedText = (message, max) => z.string({ invalid_type_error: message }).max(max, message);

const SessionBody = orEmpty(z.object({
    agentId: boundedText(AGENT_TEXT, 200).nullish(),
    voice: boundedText(VOICE_TEXT, 100).nullish(),
    language: boundedText(LANGUAGE_TEXT, 35).nullish(),
}).strict());

const HistoryEntries = z.array(z.object({
    role: z.string({ required_error: HISTORY_TEXT, invalid_type_error: HISTORY_TEXT }).max(40, HISTORY_TEXT),
    content: z.string({ required_error: HISTORY_TEXT, invalid_type_error: HISTORY_TEXT }),
}, { invalid_type_error: HISTORY_TEXT }).strict(), { invalid_type_error: HISTORY_TEXT });

// Multipart text fields are strings, and '' has always meant "not given".
const TurnFields = orEmpty(z.object({
    history: z.string({ invalid_type_error: HISTORY_TEXT })
        .transform((raw, ctx) => {
            if (!raw.trim()) return [];
            try { return JSON.parse(raw); } catch (_) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: HISTORY_TEXT });
                return z.NEVER;
            }
        })
        .pipe(HistoryEntries),
    model: boundedText('model is the name of a Mistral model.', 100),
    systemPrompt: boundedText('systemPrompt is at most 200,000 characters.', 200_000),
    voice: boundedText(VOICE_TEXT, 100),
    language: boundedText(LANGUAGE_TEXT, 35),
    agentId: boundedText(AGENT_TEXT, 200),
}).partial().strict());

/**
 * The agent, if the caller may use it — owner, or published to their org and
 * groups (auth/audience). null for "not there" and "not yours" alike, so the
 * answer never confirms that an id exists in somebody else's account.
 */
async function loadUsableAgent(req, agentId) {
    const agent = await agentStore.getForRuntime(agentId);
    if (!agent) return null;
    const audience = await resolveAudienceContext(req);
    if (agent.owner_id === audience.userId) return agent;
    // A draft is its owner's alone — a super-admin included, whom
    // canSeePublished lets through before it looks at is_published. The
    // agent chat (routes/agents/chat.js) draws the same line.
    if (!agent.is_published) return null;
    if (canSeePublished(agent, audience)) return agent;
    // The agent library's one extra rule (agentCrud.getPublishedAgentsForUser):
    // someone in no organisation sees the published agents that are in none.
    const inNoOrg = audience.orgIds instanceof Set && audience.orgIds.size === 0;
    if (inNoOrg && agent.is_published && !agent.organization_id) {
        const groups = Array.isArray(agent.shared_groups) ? agent.shared_groups : [];
        if (groups.length === 0 || groups.some((g) => audience.userGroups.includes(g))) return agent;
    }
    return null;
}

// ─── Defaults & constants ─────────────────────────────────────────
const DEFAULT_LLM_MODEL = 'mistral-large-latest';
const MAX_VOICE_TOOL_ROUNDS = 3;

const VOICE_FORMATTING_RULES =
    'This is a VOICE conversation — your reply will be spoken aloud via text-to-speech.\n' +
    'Keep replies short (1–3 sentences) and natural for speech.\n' +
    'Output ONLY plain spoken prose. NEVER output JSON, curly braces, square brackets, code blocks, markdown, bullet lists, headings, emoji, or URLs. None of these can be read aloud.\n' +
    'Do not describe tool arguments or quote internal instructions. Do not end sentences with "}" or "{" or similar structural punctuation.\n' +
    'If a detailed answer is really needed, offer to send it as text in the chat instead.\n' +
    'ALWAYS reply in the same language the user spoke in. If the user speaks Dutch, reply in Dutch. If the user speaks English, reply in English. Never switch languages unless the user explicitly asks you to. If the previous turn was in Dutch and this turn is ambiguous, stay in Dutch.';

const DRAFT_FIRST_RULES =
    '\n\nACTION CONFIRMATION RULES:\n' +
    '- Tools that READ (search, list, get, read, find) — call them directly when helpful.\n' +
    '- Tools that CREATE, SEND, MODIFY, or DELETE anything (sending email, creating or moving calendar events, setting reminders, updating files, posting messages, etc.) — NEVER call them immediately.\n' +
    '  FIRST describe in ONE short sentence exactly what you are about to do (who, what, when), then ask for confirmation in the user\'s language ("Zal ik dat doen?" / "Shall I do that?" / equivalent). WAIT for a clear "ja"/"yes"/"go ahead" before calling the tool on the NEXT turn.\n' +
    '  If the user says no or changes their mind, simply cancel and acknowledge.\n' +
    '- After executing a tool, summarize the outcome in one short sentence. If a tool fails, explain it in plain language.';

const DEFAULT_SYSTEM_PROMPT =
    'You are BeeFlow Voice — a concise, warm, spoken assistant.\n\n' +
    VOICE_FORMATTING_RULES +
    DRAFT_FIRST_RULES;

// Tools whose output only makes sense visually — filter them out of voice mode.
const VOICE_TOOL_BLOCKLIST = [
    /^generate_(image|video|music|song|sfx|tts)$/,
    /^elevenlabs_(music|sfx|tts)$/,
    /^gamma_/,
    /^signrequest_/,
    /^maps_/,
    /^workspace_update$/,
    /^notebook_write$/,
    /^notebook_create$/,
];

function filterVoiceTools(tools) {
    return (tools || []).filter(tool => {
        const name = tool?.function?.name || '';
        return !VOICE_TOOL_BLOCKLIST.some(rx => rx.test(name));
    });
}

// Map BCP-47 codes → human name for the language directive injected into
// the system prompt per turn.
const LANG_NAMES = {
    en: 'English', nl: 'Dutch', fr: 'French', de: 'German', es: 'Spanish',
    it: 'Italian', pt: 'Portuguese', hi: 'Hindi', ar: 'Arabic',
    pl: 'Polish', ru: 'Russian', tr: 'Turkish', zh: 'Chinese', ja: 'Japanese',
};
function languageName(code) {
    if (!code) return null;
    const short = String(code).toLowerCase().slice(0, 2);
    return LANG_NAMES[short] || null;
}

/**
 * Strip `_`-prefixed UI/dispatch fields and known-noise keys from a tool
 * result before sending it back to the LLM. Mirrors `buildLLMToolContent`
 * in agentRuntime/toolRoundExecutor.js — duplicated intentionally to avoid a
 * cross-dependency on the agent runtime module.
 */
function compactToolResultForLLM(result) {
    if (typeof result === 'string') return result;
    if (result == null || typeof result !== 'object') return JSON.stringify(result);
    if (result._action === 'workspace_update' && result.message) {
        return JSON.stringify({ action: 'notebook_updated', message: result.message });
    }
    const NOISE = new Set(['instruction', 'resultCount']);
    const clean = {};
    for (const [k, v] of Object.entries(result)) {
        if (k.startsWith('_')) continue;
        if (NOISE.has(k)) continue;
        clean[k] = v;
    }
    return JSON.stringify(clean);
}

/**
 * Strip residual JSON / tool-call garbage from LLM output before it goes
 * to TTS. Mistral occasionally leaks fragments like a trailing `}` or
 * bracketed code when it wavers between free-form text and tool calls.
 * The voice system prompt forbids this, but belt-and-braces: clean the
 * string so the user never hears stray punctuation.
 */
function cleanSpokenText(text) {
    if (typeof text !== 'string') return '';
    let out = text;
    // Strip fenced code blocks entirely (```...``` on their own lines).
    out = out.replace(/```[\s\S]*?```/g, ' ');
    // Remove standalone JSON-ish braces/brackets that aren't sentence punctuation.
    out = out.replace(/(^|[\s])[{}\[\]]+($|[\s])/g, '$1 $2');
    // Remove lines that are pure JSON (start with { and end with }).
    out = out.split('\n')
        .filter(line => {
            const t = line.trim();
            if (!t) return true;
            if (/^[{[].*[}\]]\s*$/.test(t)) return false;
            return true;
        })
        .join('\n');
    // Collapse whitespace.
    out = out.replace(/\s+/g, ' ').trim();
    // Trim dangling structural punctuation at the very end.
    out = out.replace(/[{}\[\]`]+\s*$/g, '').trim();
    return out;
}

/**
 * Build a ≤100-char human-readable summary for the UI tool-chip tooltip.
 * Stays separate from the LLM-facing serialization so the two can diverge.
 */
function summarizeToolResult(name, result) {
    if (result == null) return 'no result';
    if (typeof result === 'string') return result.slice(0, 100);
    if (result.error) return `error: ${String(result.error).slice(0, 90)}`;
    if (result.message) return String(result.message).slice(0, 100);
    for (const key of ['results', 'events', 'messages', 'items', 'files', 'contacts']) {
        if (Array.isArray(result[key])) return `${result[key].length} ${key}`;
    }
    return 'ok';
}

// ─── GET /ai/voice/availability ───────────────────────────────────
router.get('/availability', requireAuth, async (req, res) => {
    try {
        const hasMistral = !!(await configStore.getSecret('mistral_api_key'));
        res.json({
            enabled: hasMistral,
            reason: hasMistral ? 'ok' : 'mistral_not_configured',
            sttProvider: 'voxtral',
            ttsProvider: hasMistral ? 'voxtral' : 'elevenlabs',
            defaultModel: DEFAULT_LLM_MODEL,
        });
    } catch (err) {
        log.error('[Voice] availability error:', err);
        res.status(500).json({ enabled: false, reason: 'error' });
    }
});

// ─── POST /ai/voice/session ───────────────────────────────────────
// Resolves the agent (if any) once so the client has the right system
// prompt and label up-front. The same `agentId` is echoed back on every
// turn so the server can apply the matching tool restrictions.
router.post('/session', requireAuth, requireMistralConfigured, validate({ body: SessionBody }), async (req, res) => {
    const crypto = require('crypto');
    const sessionId = crypto.randomBytes(16).toString('hex');
    const { agentId = null, voice = null, language = null } = req.body;

    let systemPrompt = DEFAULT_SYSTEM_PROMPT;
    let model = DEFAULT_LLM_MODEL;
    let agentInfo = null;

    if (agentId) {
        const agent = await loadUsableAgent(req, agentId);
        if (!agent) return res.status(404).json({ error: 'Agent not found', code: 'agent_not_found' });
        const base = (agent.system_prompt || '').trim();
        systemPrompt = [base, VOICE_FORMATTING_RULES, DRAFT_FIRST_RULES]
            .filter(Boolean)
            .join('\n\n');
        if (agent.model) model = agent.model;
        agentInfo = { id: agent.id, name: agent.name };
    }

    res.json({
        sessionId,
        model,
        voice,
        language,
        systemPrompt,
        agentId: agentInfo?.id || null,
        agentName: agentInfo?.name || null,
        maxTurnSeconds: 60,
        sessionTimeoutMs: 15 * 60 * 1000,
    });
});

// ─── POST /ai/voice/turn (SSE) ────────────────────────────────────
router.post(
    '/turn',
    requireAuth,
    requireMistralConfigured,
    receiveTurnAudio,
    validate({ body: TurnFields }),
    async (req, res) => {
        // Everything that can refuse the turn answers before the stream opens.
        if (!req.file) {
            return res.status(400).json({ error: 'Missing audio blob', code: 'no_audio' });
        }
        const agentId = req.body.agentId || null;
        const agent = agentId ? await loadUsableAgent(req, agentId) : null;
        if (agentId && !agent) {
            return res.status(404).json({ error: 'Agent not found', code: 'agent_not_found' });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        const send = (event, data) => {
            try {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            } catch (_) { /* socket closed */ }
        };

        try {
            const apiKey = req._mistralKey;
            const language = req.body.language || null;
            const model = req.body.model || DEFAULT_LLM_MODEL;
            const sessionSystemPrompt = req.body.systemPrompt || DEFAULT_SYSTEM_PROMPT;
            const voice = req.body.voice || null;
            const history = req.body.history || [];

            // 1 ─ Transcribe
            const sttStart = Date.now();
            const stt = await voxtralStt.transcribe(apiKey, req.file.buffer, {
                mime: req.file.mimetype,
                filename: req.file.originalname,
                language,
            });
            send('transcript', {
                text: stt.text,
                language: stt.language,
                duration: stt.duration,
                latencyMs: Date.now() - sttStart,
            });

            if (!stt.text) {
                send('no_speech', {});
                send('done', { latencyMs: Date.now() - sttStart });
                return res.end();
            }

            // 2 ─ Resolve tools. If an agent was selected, prefer its tools;
            // otherwise pull the integration tools available to the user and
            // apply the voice-output blocklist.
            let voiceTools = [];
            let agentConfig = null;
            if (agent) {
                agentConfig = agent.config || null;
                if (Array.isArray(agent.tools) && agent.tools.length) {
                    voiceTools = filterVoiceTools(agent.tools);
                }
            }
            if (voiceTools.length === 0) {
                try {
                    const { tools } = await getIntegrationTools({
                        userId: req.session.user.id,
                        session: req.session,
                        isAdmin: !!req.session.isAdmin,
                        agentConfig,
                    });
                    voiceTools = filterVoiceTools(tools);
                } catch (err) {
                    log.warn('[Voice turn] tool discovery failed:', err.message);
                }
            }

            // 3 ─ Build the message array with per-turn language directive.
            const detected = languageName(stt.language);
            const langDirective = detected
                ? `\n\nThe user just spoke in ${detected}. Reply in ${detected}.`
                : '';
            const hintBlock = voiceTools.length
                ? `\n\n${await buildToolHint(voiceTools, req.session.user.id)}`
                : '';
            const finalSystemPrompt = sessionSystemPrompt + langDirective + hintBlock;

            // The client's history, as an allow-list: conversation turns only,
            // and only the two fields a turn has.
            const messages = [
                { role: 'system', content: finalSystemPrompt },
                ...history
                    .filter(m => m.role === 'user' || m.role === 'assistant')
                    .map(({ role, content }) => ({ role, content })),
                { role: 'user', content: stt.text },
            ];

            // 4 ─ Tool-calling loop.
            const adapter = getAdapter('mistral');
            let assistantText = '';
            let round = 0;
            const roundsMetrics = [];
            const execContext = {
                userId: req.session.user.id,
                session: req.session,
                orgId: req.session.user?.organizationId,
                agentId,
                req,
                send,
                // The dispatcher's chokepoint writes each tool's egress row.
                egress: {
                    source: 'voice',
                    model,
                    ids: {
                        organization_id: req.session.user?.organizationId || null,
                        user_id: req.session.user.id,
                        agent_id: agentId || null,
                    },
                },
            };

            // The Privacy Shield's tool block lists ("Outside tools" / "Own
            // server") apply here as in the agent loop (BFSF-354): a call whose
            // arguments carry a forbidden category is refused, and what the
            // model reads of a result has those categories stripped. Rules in
            // core/privacy/toolPiiGate.js; no shield leaves both lists unapplied.
            const toolPiiGate = require('../../core/privacy/toolPiiGate');
            let shield = null;
            if (voiceTools.length) {
                try {
                    const { resolveShieldFor } = require('../../core/privacy/orgShield');
                    shield = await resolveShieldFor({ orgId: req.session.user?.organizationId || null, userId: req.session.user.id });
                } catch (e) {
                    log.warn('[Voice turn] Shield lookup failed; tool block lists not applied:', e.message);
                }
            }
            const logShieldEvent = (fields) => {
                require('../../stores/guardrailEventStore').logGuardrailEvent({
                    organization_id: req.session.user?.organizationId || null,
                    user_id: req.session.user.id,
                    agent_id: agentId || null,
                    ...fields,
                    source: 'voice',
                    model,
                }).catch(() => {});
            };

            while (round < MAX_VOICE_TOOL_ROUNDS) {
                let roundText = '';
                const roundToolCalls = [];
                let firstTokenAt = null;
                const roundStart = Date.now();

                // A spoken reply: 1k tokens is already minutes of speech, and an
                // uncapped one held the single local slot for the whole call.
                const streamOpts = { temperature: 0.7, maxTokens: 1024 };
                if (voiceTools.length) {
                    streamOpts.tools = voiceTools;
                    streamOpts.toolChoice = 'auto';
                }

                await adapter.stream(apiKey, null, model, messages, streamOpts, (event, data) => {
                    if (event === 'text' && data?.text) {
                        if (!firstTokenAt) firstTokenAt = Date.now();
                        roundText += data.text;
                        send('text', { delta: data.text });
                    } else if (event === 'thinking' && data?.text) {
                        send('thinking', { delta: data.text });
                    } else if (event === 'tool_use' && data?.name) {
                        roundToolCalls.push({
                            id: data.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                            name: data.name,
                            input: data.input || {},
                        });
                    }
                });

                roundsMetrics.push({
                    round,
                    ttftMs: firstTokenAt ? firstTokenAt - roundStart : null,
                    totalMs: Date.now() - roundStart,
                    toolCalls: roundToolCalls.length,
                });

                if (roundToolCalls.length === 0) {
                    assistantText = roundText;
                    break;
                }

                // Append assistant message with tool_calls into the history
                // so the next round can see what was requested.
                messages.push({
                    role: 'assistant',
                    content: roundText || '',
                    tool_calls: roundToolCalls.map(tc => ({
                        id: tc.id,
                        type: 'function',
                        function: {
                            name: tc.name,
                            arguments: JSON.stringify(tc.input || {}),
                        },
                        _thought_signature: tc.thought_signature || tc._thought_signature || undefined,
                    })),
                });

                // Execute the tool calls in parallel and stream status
                // back to the client via SSE.
                const toolOutcomes = await Promise.all(roundToolCalls.map(async (tc) => {
                    send('tool_use', { id: tc.id, name: tc.name, input: tc.input, round });
                    try {
                        const refusal = await toolPiiGate.refuseToolCall({
                            toolName: tc.name, args: tc.input || {}, shield,
                            logEvent: logShieldEvent, tag: 'Voice ToolPiiGuard',
                        });
                        if (refusal) {
                            send('tool_result', { id: tc.id, name: tc.name, ok: false, summary: refusal.uiResult.slice(0, 100) });
                            return { tc, result: { error: refusal.modelError }, ok: false };
                        }
                        const result = await dispatchTool(tc.name, tc.input || {}, execContext);
                        const ok = !(result && typeof result === 'object' && result.error);
                        send('tool_result', {
                            id: tc.id,
                            name: tc.name,
                            ok,
                            summary: summarizeToolResult(tc.name, result),
                        });
                        return { tc, result, ok };
                    } catch (err) {
                        const errResult = { error: err.message || 'tool failed' };
                        send('tool_result', {
                            id: tc.id,
                            name: tc.name,
                            ok: false,
                            summary: errResult.error.slice(0, 100),
                        });
                        return { tc, result: errResult, ok: false };
                    }
                }));

                // Feed the tool results back to the LLM for the next round.
                for (const { tc, result } of toolOutcomes) {
                    messages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: await toolPiiGate.stripToolResultForModel(compactToolResultForLLM(result), {
                            toolName: tc.name, shield, logEvent: logShieldEvent, tag: 'Voice ToolResultDlp',
                        }),
                    });
                }

                round++;
            }

            send('llm_done', { rounds: roundsMetrics });

            // 5 ─ TTS the final reply (only non-tool assistantText).
            //      Clean stray JSON / code fragments before synthesis — the
            //      voice prompt forbids them but models sometimes leak anyway.
            const spokenText = cleanSpokenText(assistantText);
            if (spokenText.trim()) {
                const ttsStart = Date.now();
                let tts = { audioBase64: null, mimeType: 'audio/mpeg', provider: 'none' };
                let ttsReason = 'no_provider_configured';
                try {
                    tts = await voxtralTts.synthesize(spokenText, {
                        voice,
                        language: stt.language || language,
                    });
                } catch (err) {
                    const msg = String(err?.message || err);
                    if (msg.includes('no_voice_configured')) ttsReason = 'no_voice_configured';
                    else ttsReason = 'tts_failed';
                    log.warn('[Voice turn] TTS pipeline error:', msg);
                }
                if (tts.audioBase64) {
                    send('tts', {
                        audioBase64: tts.audioBase64,
                        mimeType: tts.mimeType,
                        provider: tts.provider,
                        latencyMs: Date.now() - ttsStart,
                    });
                } else {
                    send('tts_unavailable', { reason: ttsReason });
                }
            }

            send('done', {
                // Ship the cleaned text to the client too, so the chat
                // bubble matches what TTS said (no leaked "}" at the end).
                assistantText: cleanSpokenText(assistantText),
                transcript: stt.text,
                toolRounds: round,
            });
            res.end();
        } catch (err) {
            log.error('[Voice turn] error:', err);
            send('error', { message: err.message || 'Voice turn failed' });
            try { res.end(); } catch (_) { /* noop */ }
        }
    }
);

module.exports = router;
