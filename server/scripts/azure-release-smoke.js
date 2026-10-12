#!/usr/bin/env node
'use strict';
// Run only on staging with real Azure credentials. Never prints keys, tokens,
// service responses or documents. A missing capability blocks acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const OpenAI = require('openai');
const { toV1BaseUrl } = require('../utils/azureUrl');
const REQUIRED = ['STAGING_BASE_URL','RELEASE_COMMIT','AZURE_OPENAI_ENDPOINT','AZURE_OPENAI_KEY','AZURE_RESPONSES_DEPLOYMENT',
    'AZURE_EMBEDDINGS_DEPLOYMENT','AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT','AZURE_DOCUMENT_INTELLIGENCE_KEY','AZURE_SPEECH_KEY','AZURE_SPEECH_REGION'];
async function main() {
    const missing = REQUIRED.filter(key => !process.env[key]);
    if (missing.length) throw new Error(`Missing staging settings: ${missing.join(', ')}`);
    const healthUrl = new URL('/api/health', process.env.STAGING_BASE_URL);
    assert.equal(healthUrl.protocol, 'https:');
    const health = await fetch(healthUrl, { signal: AbortSignal.timeout(15000) });
    assert.ok(health.ok);
    assert.equal((await health.json()).appVersion, process.env.RELEASE_COMMIT, 'Staging server must run the candidate commit');
    const client = new OpenAI({ apiKey: process.env.AZURE_OPENAI_KEY, baseURL: toV1BaseUrl(process.env.AZURE_OPENAI_ENDPOINT), timeout: 30000, maxRetries: 0 });
    const model = process.env.AZURE_RESPONSES_DEPLOYMENT;
    const response = await client.responses.create({ model, input: 'Reply with staging validated.', max_output_tokens: 512, store: false });
    assert.ok(response.output_text?.trim());
    let streamed = '';
    for await (const event of await client.responses.create({ model, input: 'Reply with streaming validated.', max_output_tokens: 512, store: false, stream: true })) {
        if (event.type === 'response.output_text.delta') streamed += event.delta;
        if (event.type === 'error' || event.type === 'response.failed') throw new Error('Azure streaming failed');
    }
    assert.ok(streamed.trim());
    const tool = await client.responses.create({ model, input: 'Call staging_check with value validated.', max_output_tokens: 512, store: false,
        tools: [{ type: 'function', name: 'staging_check', description: 'Confirm the staging test.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, strict: true }],
        tool_choice: { type: 'function', name: 'staging_check' } });
    assert.ok(tool.output.some(item => item.type === 'function_call' && item.name === 'staging_check'));
    const vectors = await client.embeddings.create({ model: process.env.AZURE_EMBEDDINGS_DEPLOYMENT, input: 'Bee Flow staging validation' });
    assert.ok(vectors.data[0]?.embedding?.length);
    const { PDFDocument, StandardFonts } = require('pdf-lib');
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    page.drawText('Bee Flow Azure staging validation', { x: 40, y: 700, size: 20, font: await pdf.embedFont(StandardFonts.Helvetica) });
    const bytes = await pdf.save();
    const documentSdk = require('@azure-rest/ai-document-intelligence');
    const { AzureKeyCredential } = require('@azure/core-auth');
    const documents = documentSdk.default(process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT, new AzureKeyCredential(process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY));
    const initial = await documents.path('/documentModels/{modelId}:analyze', 'prebuilt-layout').post({
        body: { base64Source: Buffer.from(bytes).toString('base64') }, contentType: 'application/json',
        queryParameters: { 'api-version': '2024-11-30', outputContentFormat: 'markdown' },
    });
    assert.equal(initial.status, '202');
    const poller = await documentSdk.getLongRunningPoller(documents, initial);
    const analyzed = await poller.pollUntilDone({ abortSignal: AbortSignal.timeout(180000) });
    assert.match(analyzed.body.analyzeResult.content, /Bee Flow/i);
    const speech = require('microsoft-cognitiveservices-speech-sdk');
    const speechConfig = speech.SpeechConfig.fromSubscription(process.env.AZURE_SPEECH_KEY, process.env.AZURE_SPEECH_REGION);
    const synthesizer = new speech.SpeechSynthesizer(speechConfig, null);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { synthesizer.close(); reject(new Error('Azure speech timed out')); }, 45000);
        synthesizer.speakTextAsync('Bee Flow staging validation.', result => {
            clearTimeout(timer); synthesizer.close();
            if (result.reason === speech.ResultReason.SynthesizingAudioCompleted && result.audioData?.byteLength) resolve();
            else reject(new Error('Azure speech synthesis failed'));
        }, () => { clearTimeout(timer); synthesizer.close(); reject(new Error('Azure speech request failed')); });
    });
    const report = { schema: 1, commit: process.env.RELEASE_COMMIT, checkedAt: new Date().toISOString(),
        checks: { responses: true, streaming: true, toolcalls: true, embeddings: true, documentAnalysis: true, speech: true } };
    fs.writeFileSync(process.env.AZURE_SMOKE_REPORT || 'azure-smoke.json', `${JSON.stringify(report, null, 2)}\n`);
    console.log('Azure staging smoke: Responses, streaming, tool calls, embeddings, document analysis and speech passed');
}
if (require.main === module) main().catch(err => {
    console.error(err.message.startsWith('Missing staging settings:') ? err.message : 'Azure staging smoke failed; check staging configuration and service diagnostics.');
    process.exitCode = 1;
});
module.exports = { main };
