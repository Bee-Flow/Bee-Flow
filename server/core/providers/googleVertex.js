/**
 * Google Vertex AI Provider Adapter
 *
 * Extends GoogleProvider — inherits all message normalization, streaming,
 * tool/function calling, thinking, and image generation logic.
 * Only difference: SDK initialization uses `vertexai: true` with
 * project/location + service account credentials.
 *
 * Authentication (in order of priority):
 * 1. Service account JSON key (configured via UI, stored in config)
 * 2. Application Default Credentials (ADC) as fallback
 */

const GoogleProvider = require('./google');
const log = require('../../telemetry/log');

class GoogleVertexProvider extends GoogleProvider {
    constructor() {
        super();
        this.name = 'google-vertex';
    }

    // ─── SDK Client (Vertex AI mode) ─────────────────────────────

    /**
     * Create a Vertex AI client.
     * apiKey is ignored — auth comes from service account key or ADC.
     * project, location, and serviceAccountKey come from provider config (passed via options).
     */
    createClient(apiKey, options = {}) {
        const { GoogleGenAI } = require('@google/genai');

        const project = options.project || process.env.GOOGLE_CLOUD_PROJECT;
        const location = options.location || process.env.GOOGLE_CLOUD_LOCATION || 'europe-west4';

        if (!project) {
            throw new Error('Google Vertex AI requires a project ID. Configure it in AI Settings → API Keys.');
        }

        log.info(`[GoogleVertex] Creating client for project=${project}, location=${location}`);

        const clientConfig = {
            vertexai: true,
            project,
            location,
        };

        // Use service account key if provided (enables full UI-based setup)
        if (options.serviceAccountKey) {
            try {
                const credentials = typeof options.serviceAccountKey === 'string'
                    ? JSON.parse(options.serviceAccountKey)
                    : options.serviceAccountKey;

                clientConfig.googleAuthOptions = { credentials };
                log.info(`[GoogleVertex] Using service account: ${credentials.client_email || 'unknown'}`);
            } catch (e) {
                log.error('[GoogleVertex] Failed to parse service account key:', e.message);
                throw new Error('Invalid service account JSON key. Please check the format.');
            }
        }

        return new GoogleGenAI(clientConfig);
    }

    // Vertex mode does not use the SDK explicit context-cache API — the
    // inherited GoogleProvider.chat/stream skip it based on this. chat, stream
    // and generateImage are inherited unchanged (now passing options to
    // this.createClient), which also gives Vertex the thought_signature,
    // stop_reason and reasoning-token accounting its old copies were missing.
    _supportsExplicitCache() {
        return false;
    }


    /**
     * List models via Vertex AI SDK.
     * Supplements API results with well-known Gemini models since the
     * Vertex AI models.list() endpoint doesn't return all available models.
     *
     * If no credentials are configured (no service account key and no ADC),
     * returns only the well-known models without making an API call.
     */
    async listModels(apiKey, baseUrl, options = {}) {
        const knownModels = [
            { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
            { id: 'gemini-2.5-pro-preview-06-05', name: 'Gemini 2.5 Pro Preview' },
            { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
            { id: 'gemini-2.5-flash-preview-05-20', name: 'Gemini 2.5 Flash Preview' },
            { id: 'gemini-2.5-flash-lite-preview-06-17', name: 'Gemini 2.5 Flash Lite Preview' },
            { id: 'gemini-2.0-flash-001', name: 'Gemini 2.0 Flash 001' },
            { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite' },
            { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash Experimental' },
            { id: 'gemini-2.0-flash-thinking-exp', name: 'Gemini 2.0 Flash Thinking' },
        ];

        // Skip API call if no credentials are available — avoids noisy auth errors
        const hasServiceAccountKey = !!(options.serviceAccountKey);
        const hasADC = !!(process.env.GOOGLE_APPLICATION_CREDENTIALS);
        if (!hasServiceAccountKey && !hasADC) {
            log.info(`[GoogleVertex] No credentials configured — returning ${knownModels.length} well-known models (skipping API call)`);
            return knownModels;
        }

        try {
            const ai = this.createClient(apiKey, options);
            const models = [];
            let pageToken = undefined;

            // Fetch all pages from the API
            do {
                const config = { pageSize: 300 };
                if (pageToken) config.pageToken = pageToken;

                const result = await ai.models.list({ config });

                for await (const model of result) {
                    let id = model.name || '';
                    const match = id.match(/models\/(.+)$/);
                    if (match) id = match[1];

                    models.push({
                        id,
                        name: model.displayName || id,
                    });
                }

                pageToken = result.pageToken || result.nextPageToken;
            } while (pageToken);

            // Supplement with well-known Gemini models not returned by the API
            const existingIds = new Set(models.map(m => m.id));
            let added = 0;
            for (const known of knownModels) {
                if (!existingIds.has(known.id)) {
                    models.push(known);
                    added++;
                }
            }

            log.info(`[GoogleVertex] Found ${models.length} models (${models.length - added} from API, ${added} supplemented)`);
            return models;
        } catch (e) {
            log.error('[GoogleVertex] SDK listModels failed:', e.message);
            return knownModels;
        }
    }

    /**
     * Generate music via Vertex AI (Lyria RealTime).
     */
    async generateMusic(apiKey, prompt, options = {}) {
        const { GoogleGenAI } = require('@google/genai');

        const project = options.project || process.env.GOOGLE_CLOUD_PROJECT;
        const location = options.location || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

        const clientConfig = {
            vertexai: true,
            project,
            location,
            httpOptions: { apiVersion: 'v1alpha' },
        };

        if (options.serviceAccountKey) {
            try {
                const credentials = typeof options.serviceAccountKey === 'string'
                    ? JSON.parse(options.serviceAccountKey)
                    : options.serviceAccountKey;
                clientConfig.googleAuthOptions = { credentials };
            } catch (e) { /* ignore */ }
        }

        // We need a custom client for music (v1alpha), so we replicate parent logic
        // with Vertex credentials
        const ai = new GoogleGenAI(clientConfig);

        const durationMs = (options.durationSeconds || 10) * 1000;
        const bpm = options.bpm || 90;
        const temperature = options.temperature || 1.0;

        log.info(`[GoogleVertex] Music generation: "${prompt.substring(0, 80)}" (${durationMs / 1000}s, ${bpm} BPM)`);

        const audioChunks = [];

        try {
            const session = await ai.live.music.connect({
                model: 'models/lyria-realtime-exp',
            });

            const weightedPrompts = options.weightedPrompts || [
                { text: prompt, weight: 1.0 },
            ];

            await session.setWeightedPrompts({ weightedPrompts });
            await session.setMusicGenerationConfig({
                musicGenerationConfig: { bpm, temperature },
            });

            await session.play();

            const timeout = setTimeout(() => {
                try { session.close(); } catch (e) { /* ignore */ }
            }, durationMs);

            for await (const message of session.receive()) {
                const chunk = message.serverContent?.audioChunks?.[0]?.data;
                if (chunk) audioChunks.push(Buffer.from(chunk, 'base64'));
            }

            clearTimeout(timeout);
        } catch (err) {
            log.error('[GoogleVertex] Lyria RealTime error:', err.message);
            if (audioChunks.length === 0) throw new Error(`Music generation failed: ${err.message}`);
        }

        if (audioChunks.length === 0) return { audioBase64: null, mimeType: 'audio/wav' };

        const pcmData = Buffer.concat(audioChunks);
        const wavBuffer = this._writeWavHeader(pcmData);

        log.info(`[GoogleVertex] Music generated: ${audioChunks.length} chunks, ${(wavBuffer.length / 1024).toFixed(0)} KB`);

        return { audioBase64: wavBuffer.toString('base64'), mimeType: 'audio/wav' };
    }

    /**
     * Generate a video via Vertex AI (Veo 3.1).
     */
    async generateVideo(apiKey, prompt, options = {}) {
        const ai = this.createClient(apiKey, options);
        const model = options.model || 'veo-3.1-generate-001';

        log.info(`[GoogleVertex] Video generation: "${prompt.substring(0, 80)}" (model: ${model})`);

        let operation = await ai.models.generateVideos({
            model,
            prompt,
            config: {
                aspectRatio: options.aspectRatio || '16:9',
                durationSeconds: options.durationSeconds || 8,
                resolution: options.resolution || '720p',
                numberOfVideos: 1,
                enhancePrompt: true,
            },
        });

        const maxPollTime = 5 * 60 * 1000;
        const pollInterval = 5000;
        const startTime = Date.now();

        while (!operation.done) {
            if (Date.now() - startTime > maxPollTime) {
                throw new Error('Video generation timed out after 5 minutes');
            }
            await new Promise(r => setTimeout(r, pollInterval));
            operation = await ai.operations.get({ operation });
            log.info(`[GoogleVertex] Video polling... ${((Date.now() - startTime) / 1000).toFixed(0)}s elapsed`);
        }

        const video = operation.response?.generatedSamples?.[0];
        if (!video?.video) {
            return { videoBase64: null, mimeType: 'video/mp4' };
        }

        const videoData = await ai.files.download({ file: video.video });
        const videoBuffer = Buffer.from(videoData);

        log.info(`[GoogleVertex] Video generated: ${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB`);

        return { videoBase64: videoBuffer.toString('base64'), mimeType: 'video/mp4' };
    }
}

module.exports = GoogleVertexProvider;

