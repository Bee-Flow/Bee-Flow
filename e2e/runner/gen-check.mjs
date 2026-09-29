/**
 * npm run gen:check — deterministic freshness gate (no API key needed).
 *
 * Fails when a scenario changed without regenerating its committed spec,
 * when a generated-mode scenario has no spec, or when an orphaned spec
 * exists (no matching scenario / scenario went agentic-only).
 * App-map drift is a warning only: it degrades FUTURE generations but does
 * not invalidate committed specs.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  E2E_ROOT,
  GENERATED_DIR,
  loadScenarios,
  scenarioHash,
  specHashOf,
  specPathFor,
} from './scenarios.mjs';

const APP_MAP_FILE = path.join(E2E_ROOT, 'context', 'app-map.md');

function main() {
  const errors = [];
  const scenarios = loadScenarios();
  const generated = scenarios.filter((s) => s.mode.includes('generated'));

  for (const s of generated) {
    const specFile = specPathFor(s.id);
    if (!fs.existsSync(specFile)) {
      errors.push(
        `scenario '${s.id}' (mode: ${s.mode}) has no committed spec. Run: cd e2e && npm run gen -- ${s.id}`,
      );
      continue;
    }
    const spec = fs.readFileSync(specFile, 'utf8');
    if (!spec.includes('AUTO-GENERATED')) {
      errors.push(`tests/generated/${s.id}.spec.ts is missing the AUTO-GENERATED header — regenerate it.`);
    }
    const embedded = specHashOf(spec);
    if (embedded !== s.hash) {
      errors.push(
        `scenario '${s.id}' changed without regeneration. ` +
          `Run: cd e2e && npm run gen -- ${s.id}, review the diff, and commit both files.`,
      );
    }
  }

  const specFiles = fs.existsSync(GENERATED_DIR)
    ? fs.readdirSync(GENERATED_DIR).filter((f) => f.endsWith('.spec.ts'))
    : [];
  for (const f of specFiles) {
    const id = f.replace(/\.spec\.ts$/, '');
    const s = scenarios.find((x) => x.id === id);
    if (!s) {
      errors.push(`orphaned spec tests/generated/${f}: no scenarios/${id}.md exists — delete it.`);
    } else if (!s.mode.includes('generated')) {
      errors.push(
        `orphaned spec tests/generated/${f}: scenario '${id}' is agentic-only (mode: ${s.mode}) — delete the spec.`,
      );
    }
  }

  // App-map drift warning (informational).
  if (fs.existsSync(APP_MAP_FILE)) {
    const current = scenarioHash(fs.readFileSync(APP_MAP_FILE, 'utf8')).slice(0, 12);
    for (const s of generated) {
      const specFile = specPathFor(s.id);
      if (!fs.existsSync(specFile)) continue;
      const m = fs.readFileSync(specFile, 'utf8').match(/app-map-hash:\s*sha256:([0-9a-f]{12})/);
      if (m && m[1] !== current) {
        console.warn(
          `[gen:check] warning: '${s.id}' was generated against an older app-map ` +
            '(fine for now; consider regenerating after larger UI changes).',
        );
      }
    }
  }

  if (errors.length) {
    for (const e of errors) console.error(`[gen:check] ERROR: ${e}`);
    process.exit(1);
  }
  console.log(`[gen:check] OK — ${generated.length} generated spec(s) in sync, no orphans.`);
}

main();
