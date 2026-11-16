/**
 * The vendor-name ratchet reads the merged English dictionary; these cases pin what it counts (a vendor or model
 * name in an admin namespace) and what it leaves alone (other namespaces, the provider-card allow-list).
 */

import test from 'node:test';
import assert from 'node:assert';

import { vendorKeys, isAllowed, ADMIN_NAMESPACE } from './vendor-name-ratchet.mjs';

test('counts vendor and model names in the admin namespaces only', () => {
    const dict = {
        'admin_ai_config.claude_title': 'Claude Settings',
        'appearance.icons_nano': 'Uses Nano Banana',
        'azure.embed_label': 'Azure OpenAI Embeddings',
        'mcp_access.reveal.commands': 'Connect Claude Code',
        'org.hint': 'Pick GPT-5 or Gemini',
        'common.neutral': 'Choose a model',
        'chat.model_note': 'Claude is thinking',
        'agent.desc': 'Uses ChatGPT',
        'settings.tag': 'e.g. mistral-embed',
    };
    assert.deepStrictEqual(vendorKeys(dict), [
        'admin_ai_config.claude_title', 'appearance.icons_nano', 'azure.embed_label', 'mcp_access.reveal.commands', 'org.hint', 'settings.tag',
    ]);
});

test('the provider-card allow-list is skipped', () => {
    for (const key of [
        'admin_ai_config.pk_claude_desc', 'admin_ai_config.tier_hint_gpt5', 'admin_ai_config.azure_image_deployment',
        'admin_ai_config.openai_eu_on', 'admin_ai_config.azure_models_hint', 'admin_ai_config.vertex_subtitle',
        'admin_ai_config.local_subtitle', 'admin_ai_config.scaleway_hint', 'admin_ai_config.row_tag_placeholder',
        'admin_ai_config.rerank_provider_help', 'mcp_access.connect_claude_code', 'integ.transcription_openai',
        'integ.services_azure_openai_studio',
    ]) assert.ok(isAllowed(key), key);
    for (const key of ['admin_ai_config.claude_title', 'integ.services_use_azure', 'admin_ai_config.rerank_provider_title']) {
        assert.ok(!isAllowed(key), key);
    }
    assert.deepStrictEqual(vendorKeys({ 'admin_ai_config.pk_claude_desc': 'Required for Claude models' }), []);
});

test('admin namespaces', () => {
    for (const ns of ['admin', 'admin_ai_config', 'org', 'mcp_access', 'settings', 'azure', 'integ', 'appearance', 'common', 'learn']) {
        assert.ok(ADMIN_NAMESPACE.test(ns), ns);
    }
    for (const ns of ['chat', 'agent', 'mcp', 'settings_x', 'commons']) assert.ok(!ADMIN_NAMESPACE.test(ns), ns);
});
