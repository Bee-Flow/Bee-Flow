#!/usr/bin/env node
/**
 * Vendor-name ratchet: English UI strings in the admin namespaces that name an AI vendor or model may only go down.
 *
 * The admin dashboard is provider-neutral: "the model", "your AI provider", a tier name. A vendor or model name in a
 * label ("Claude Settings", "uses Nano Banana", "GPT-5 output length") ties a screen to one provider and goes stale
 * with the next model. The pages that configure one provider ARE about that provider, so their keys are allowed
 * (ALLOWED_KEY: the provider cards' key fields, the per-provider effort hints, the Azure deployment fields, the EU
 * endpoint switch, the self-hosted, Vertex and Scaleway subtitles, the transcription and Azure OpenAI service rows).
 *
 * Read from the dictionary itself (server/i18n/defaults/en, through require, so a key is counted once with its
 * merged value; the namespace files of every root, modules/<id>/server included), not from source text. Namespaces counted: ADMIN_NAMESPACE. Same budget contract as
 * scripts/count-ratchet.mjs: server/.vendor-name-ratchet.json, a rise fails, `--update` only lowers.
 *
 * Usage:
 *   node scripts/vendor-name-ratchet.mjs            gate
 *   node scripts/vendor-name-ratchet.mjs --update   lower the budget
 *   node scripts/vendor-name-ratchet.mjs --list     every counted key with its value
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';
import { gateBudget } from './ratchet-budget.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const VENDOR_NAME = /claude|anthropic|gpt-|openai|gemini|nano banana|sonnet|haiku|mistral-embed|chatgpt/i;

/** The namespaces of the admin dashboard and the settings it shares. */
export const ADMIN_NAMESPACE = /^(?:admin\w*|org\w*|mcp_\w+|settings|azure|integ|appearance|common|learn|plan_templates|icon_gen)$/;

/** Keys of the screens that configure one provider, where naming it is the point. Matched on the key after its namespace, or on the whole key for `ns.prefix` entries. */
export const ALLOWED_KEY = [
    /^(?:pk_|tier_hint_|azure_image_|openai_eu_|azure_models_)/,
    /^(?:connect_claude_code|vertex_subtitle|local_subtitle|scaleway_hint|row_tag_placeholder|rerank_provider_help)$/,
];
export const ALLOWED_FULL_KEY = /^integ\.(?:transcription_|services_azure_openai_)/;

export function isAllowed(key) {
    if (ALLOWED_FULL_KEY.test(key)) return true;
    const rest = key.slice(key.indexOf('.') + 1);
    return ALLOWED_KEY.some((re) => re.test(rest));
}

/**
 * The keys that name a vendor, in the admin namespaces, minus the allow-list.
 * @param {Record<string, string>} dictionary key -> English value
 * @returns {string[]}
 */
export function vendorKeys(dictionary) {
    return Object.entries(dictionary)
        .filter(([key, value]) => ADMIN_NAMESPACE.test(key.split('.')[0]) && typeof value === 'string' && VENDOR_NAME.test(value) && !isAllowed(key))
        .map(([key]) => key)
        .sort();
}

function main() {
    const args = process.argv.slice(2);
    const require = createRequire(import.meta.url);
    // The resolver first, as in the server: the dictionary then holds the namespace files of every root.
    // Not in core mode: a hidden module would lower the count, and an --update the budget with it.
    delete process.env.BEEFLOW_HIDE_MODULES;
    require(path.join(ROOT, 'server/moduleRoots.cjs'));
    const { GUI_DEFAULTS } = require(path.join(ROOT, 'server/i18n/defaults/en/index.js'));
    const keys = vendorKeys(GUI_DEFAULTS);
    const oneLine = (s) => s.replace(/\s+/g, ' ').slice(0, 100);
    process.exit(gateBudget({
        root: ROOT,
        budgetFile: path.join(ROOT, 'server/.vendor-name-ratchet.json'),
        count: keys.length,
        rows: keys.map((k) => [1, `${k}  ${oneLine(GUI_DEFAULTS[k])}`]),
        label: 'server',
        what: 'English strings naming an AI vendor or model',
        where: 'in the admin namespaces of server/i18n/defaults/en',
        advice: 'word it provider-neutrally ("the model", "your AI provider", the tier name); a key on a screen that configures one provider belongs in ALLOWED_KEY of scripts/vendor-name-ratchet.mjs',
        command: 'node scripts/vendor-name-ratchet.mjs',
        update: args.includes('--update'),
        list: args.includes('--list'),
    }));
}

if (isEntryPoint(import.meta.url)) main();
