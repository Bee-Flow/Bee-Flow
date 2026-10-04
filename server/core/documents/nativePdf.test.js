const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const log = require('../../telemetry/log');
const OpenAIProvider = require('../providers/openai');
const AzureProvider = require('../providers/azure');
const ClaudeProvider = require('../providers/claude');
const MistralProvider = require('../providers/mistral');
const { parseDeployments, setAzureDeployments } = require('../providers/azureDeployments');
const {
    nativePdfPart, nativePdfDecision, acceptsNativePdf, isShieldActive, NATIVE_PDF_MAX_BYTES,
} = require('./nativePdf');

const PDF_B64 = Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF').toString('base64');

// Deployment → model mapping is a module registry; set it for this file, clear it after.
before(() => setAzureDeployments(parseDeployments('prod-chat=gpt-4.1, cheap=o3-mini, legacy=gpt-4o')));
after(() => setAzureDeployments([]));

function part(over = {}) {
    return nativePdfPart({
        adapter: new OpenAIProvider(), modelId: 'gpt-4o', providerType: 'openai',
        shieldActive: false, tokenised: false, base64Data: PDF_B64,
        mediaType: 'application/pdf', filename: 'invoice-2026.pdf', tag: 'Test', ...over,
    });
}

describe('nativePdfPart: shield off, file-capable model', () => {
    for (const [providerType, adapter, modelId] of [
        ['openai', new OpenAIProvider(), 'gpt-4o'],
        ['azure', new AzureProvider(), 'prod-chat'],
        ['claude', new ClaudeProvider(), 'claude-sonnet-4-5'],
        ['anthropic', new ClaudeProvider(), 'claude-sonnet-4-5'],
    ]) {
        test(`${providerType} gets the document part with a filename`, () => {
            const p = part({ adapter, modelId, providerType });
            assert.deepEqual(p, {
                type: 'document',
                title: 'invoice-2026.pdf',
                source: { type: 'base64', media_type: 'application/pdf', data: PDF_B64 },
            });
        });
    }

    test('the OpenAI translation turns it into an input_file with the real filename', () => {
        const { toResponsesPart } = require('../providers/openaiContent');
        const out = toResponsesPart(part(), 'user');
        assert.equal(out.type, 'input_file');
        assert.equal(out.filename, 'invoice-2026.pdf');
        assert.equal(out.file_data, `data:application/pdf;base64,${PDF_B64}`);
    });

    test('a non-pdf media type falls back to application/pdf', () => {
        assert.equal(part({ mediaType: 'application/octet-stream' }).source.media_type, 'application/pdf');
    });
});

describe('nativePdfPart: privacy', () => {
    test('shield active but the scan found nothing → no document part', (t) => {
        const info = t.mock.method(log, 'info', () => {});
        for (const providerType of ['openai', 'azure', 'claude']) {
            const adapter = providerType === 'claude' ? new ClaudeProvider() : providerType === 'azure' ? new AzureProvider() : new OpenAIProvider();
            const modelId = providerType === 'claude' ? 'claude-sonnet-4-5' : 'gpt-4o';
            assert.equal(part({ adapter, modelId, providerType, shieldActive: true, tokenised: false }), null);
        }
        // Says why, never which file.
        assert.equal(info.mock.callCount(), 3);
        for (const call of info.mock.calls) {
            assert.match(call.arguments[0], /reason=privacy_shield_active/);
            assert.doesNotMatch(call.arguments[0], /invoice/);
        }
    });

    test('tokenised text → no document part (even if the shield flag were off)', () => {
        assert.equal(part({ tokenised: true }), null);
        assert.equal(nativePdfDecision({ providerType: 'azure', supportsDocuments: true, tokenised: true, bytes: 10 }).reason, 'text_redacted');
    });

    test('isShieldActive follows the shield master switch', () => {
        assert.equal(isShieldActive(null), false);
        assert.equal(isShieldActive({ enabled: false, piiAction: 'tokenize' }), false);
        assert.equal(isShieldActive({ enabled: true, piiAction: 'warn' }), true);
    });
});

describe('nativePdfPart: capability and size', () => {
    test('non-vision OpenAI model → none', () => {
        assert.equal(part({ modelId: 'o3-mini' }), null);
    });

    test('Azure deployment of a non-vision model → none (deployment name is mapped)', () => {
        assert.equal(part({ adapter: new AzureProvider(), modelId: 'cheap', providerType: 'azure' }), null);
    });

    test('Azure deployment that fell back to Chat Completions → none', () => {
        const a = new AzureProvider();
        a._completionsOnly.add('legacy');
        assert.equal(part({ adapter: a, modelId: 'legacy', providerType: 'azure' }), null);
    });

    test('a provider type outside the list → none, even when its adapter resolves to OpenAI', () => {
        assert.equal(part({ providerType: 'local' }), null);
        assert.equal(part({ adapter: new MistralProvider(), modelId: 'mistral-large-latest', providerType: 'mistral' }), null);
    });

    test('above the size cap → none; at the cap → allowed', () => {
        const base = { providerType: 'openai', supportsDocuments: true, shieldActive: false, tokenised: false };
        assert.equal(acceptsNativePdf({ ...base, bytes: NATIVE_PDF_MAX_BYTES }), true);
        assert.deepEqual(nativePdfDecision({ ...base, bytes: NATIVE_PDF_MAX_BYTES + 1 }), { send: false, reason: 'too_large' });
        assert.equal(acceptsNativePdf({ ...base, bytes: 0 }), false);
    });

    test('missing adapter → none', () => {
        assert.equal(part({ adapter: null }), null);
    });
});
