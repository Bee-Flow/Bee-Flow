#!/usr/bin/env node
// First-pass JavaScript -> TypeScript conversion of agent-hub files by a LOCAL
// model (anything that speaks the OpenAI chat API: ollama, llama.cpp, LM
// Studio). The local model only drafts; it decides nothing. Claude Code drives
// this script, then runs the typecheck, the ts-equivalence gate, eslint and the
// tests, repairs or reverts what fails, and commits. See
// .claude/handoff/ts-conversion/README.md for the whole loop.
//
//   node scripts/ts-convert-local.mjs --batch .claude/handoff/ts-conversion/batches/23.txt \
//        [--endpoint http://127.0.0.1:8080/v1] [--model local] [--only a.jsx,b.js] [--dry]
//
// Defaults fit a llama-server (llama.cpp) on the usual port; ollama is
// --endpoint http://127.0.0.1:11434/v1 --model <name>. LOCAL_LLM_ENDPOINT and
// LOCAL_LLM_MODEL set the same two things.
//
// Per file: git mv to the TypeScript name, ask the model for the typed source,
// write it. Importers that name the file with an extension, tests that read it,
// the gate and every check are left to the driver (Claude Code), on purpose.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = path.join(ROOT, 'agent-hub');

export const RULES = `You convert one JavaScript file of a React 19 / Vite app to TypeScript (strict, noImplicitAny). Add TYPES ONLY.
- Keep every expression, statement, default value, JSX element and prop exactly as it is. The compiled JavaScript must be identical: no .filter(Boolean) -> .filter(x => Boolean(x)), no .getTime(), no new temporaries, guards, ?. or ??, no removed lines.
- Add: a Props interface or type per component, parameter and return types, generics for useState/useRef, types for module constants; use 'import type' for type-only imports. Prefer a concrete shape over Record<string, unknown>.
- Direct assertions on a value are fine (e.target as HTMLInputElement, rows as Row[]).
- Forbidden: any, 'as any', 'as unknown as', @ts-ignore, @ts-expect-error, @ts-nocheck, non-null !, eslint-disable comments.
- Delete JSDoc @param/@typedef blocks that only repeat the types you add; keep every other comment.
- If a construct cannot be typed under these rules, leave that line untouched and add nothing for it.
Answer with ONLY the complete file in one \`\`\`tsx code block, nothing before or after it.`;

export function targetName(file) {
    if (file.endsWith('.jsx')) return file.replace(/\.jsx$/, '.tsx');
    const src = fs.existsSync(path.join(HUB, file)) ? fs.readFileSync(path.join(HUB, file), 'utf8') : '';
    return file.replace(/\.js$/, /<[A-Za-z][\w.]*[\s/>]/.test(src) ? '.tsx' : '.ts');
}

export function buildMessages(file, source) {
    return [
        { role: 'system', content: RULES },
        { role: 'user', content: `File: agent-hub/${file}\n\n\`\`\`jsx\n${source}\n\`\`\`` },
    ];
}

/** The file body out of the model's answer; null when there is no single code block. */
export function extractCode(answer) {
    const blocks = [...String(answer).matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
    if (blocks.length !== 1) return null;
    const code = blocks[0].replace(/\s+$/, '') + '\n';
    return /\bimport\b|\bexport\b/.test(code) ? code : null;
}

async function complete(endpoint, model, messages) {
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 16000, stream: false }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    return json.choices?.[0]?.message?.content ?? '';
}

function arg(name, fallback) { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const batch = arg('--batch'); if (!batch) { console.error('usage: --batch <list file> [--endpoint url] [--model name] [--only a,b] [--dry]'); process.exit(2); }
    const endpoint = arg('--endpoint', process.env.LOCAL_LLM_ENDPOINT || 'http://127.0.0.1:8080/v1');
    const model = arg('--model', process.env.LOCAL_LLM_MODEL || 'local');
    const only = arg('--only', '').split(',').filter(Boolean);
    const dry = process.argv.includes('--dry');
    const files = fs.readFileSync(batch, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
        .filter((f) => !only.length || only.includes(f) || only.includes(path.basename(f)))
        .filter((f) => fs.existsSync(path.join(HUB, f)));
    const result = { converted: [], skipped: [], model, endpoint };
    for (const file of files) {
        const source = fs.readFileSync(path.join(HUB, file), 'utf8');
        const target = targetName(file);
        try {
            const answer = await complete(endpoint, model, buildMessages(file, source));
            const code = extractCode(answer);
            if (!code) { result.skipped.push({ file, reason: 'no single code block in the answer' }); continue; }
            if (!dry) {
                execFileSync('git', ['-C', HUB, 'mv', file, target]);
                fs.writeFileSync(path.join(HUB, target), code);
            }
            result.converted.push({ file, target });
            console.error(`converted ${file} -> ${target}`);
        } catch (e) {
            result.skipped.push({ file, reason: String(e.message || e).slice(0, 200) });
            console.error(`skipped   ${file}: ${e.message}`);
        }
    }
    console.log(JSON.stringify(result, null, 1));
}
