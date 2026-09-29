#!/usr/bin/env node
/**
 * template-to-file — a template MODULE, written out as an importable file.
 *
 * The gap this closes
 * -------------------
 * A template can be born as code (`appStudio/templates/*.js`, shipped in the
 * image) or as a row captured from a live app. The import tab in Studio → Apps
 * reads the interchange format — `beeflow.apptemplate` JSON — and a template
 * module is not that: it is JavaScript.
 *
 * It stays that way on purpose. A route that took a `.js` file and evaluated it
 * would be arbitrary code execution on the API, dressed up as a feature, and no
 * amount of sandboxing makes "upload a script we will run" a sensible thing for
 * a privacy product to offer. The conversion belongs on a machine that already
 * trusts the file — yours, in a terminal, where `require` is what you were going
 * to do with it anyway.
 *
 * So: this converts, and the product imports.
 *
 * Which means THIS script runs the file. `require` executes a module's top
 * level, so point it only at a template you would have opened in your editor
 * anyway. That is a reasonable thing to ask of a developer at a terminal and an
 * unreasonable thing to ask of a route accepting uploads, which is the whole
 * distinction.
 *
 *   node server/scripts/template-to-file.js <path-to-module.js> [-o out.json]
 *   node server/scripts/template-to-file.js --id app-quote-intake
 *   node server/scripts/template-to-file.js --list
 *
 * The output goes through the SAME `buildExport` the export route uses, so a
 * file made here and a file downloaded from the gallery are the same file:
 * allow-listed fields, the shared scrub, a provenance block, one format.
 *
 * It refuses to write a file the product would refuse to read. `--check` runs
 * the import gate (`sanitizeImport`) against what it just built and reports the
 * verdict, because a converter that cheerfully emits an unimportable file has
 * only moved the disappointment later.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { buildExport, sanitizeImport, exportFilename } = require('../appStudio/templatePortability');
const { listTemplates, getTemplate, templateVersion } = require('../appStudio/templates');

function usage(code = 0) {
    const out = code === 0 ? console.log : console.error;
    out(`
template-to-file — write an App Studio template module out as an importable file

  node server/scripts/template-to-file.js <module.js> [options]
  node server/scripts/template-to-file.js --id <template-id> [options]
  node server/scripts/template-to-file.js --list

Options
  -o, --out <path>   where to write (default: <slug>.beeflow-app.json, here)
      --stdout       write the JSON to stdout instead of a file
      --no-check     skip the import-gate check (it is on by default)
  -h, --help

Then: Studio → Apps → New app → From a file.
`.trim());
    process.exit(code);
}

function parseArgs(argv) {
    const args = { file: null, id: null, out: null, stdout: false, check: true, list: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '-h' || a === '--help') usage(0);
        else if (a === '--list') args.list = true;
        else if (a === '--stdout') args.stdout = true;
        else if (a === '--no-check') args.check = false;
        else if (a === '--id') args.id = argv[++i];
        else if (a === '-o' || a === '--out') args.out = argv[++i];
        else if (a.startsWith('-')) { console.error(`Unknown option: ${a}`); usage(1); }
        else if (!args.file) args.file = a;
        else { console.error(`Unexpected argument: ${a}`); usage(1); }
    }
    return args;
}

/**
 * Load the template object.
 *
 * A module may export the template itself (`module.exports = { id, title, … }`)
 * or wrap it (`{ template }`) — both shapes exist in the wild, and guessing
 * between them is cheaper than a convention nobody will remember.
 */
function loadFromModule(file) {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) {
        console.error(`No such file: ${abs}`);
        process.exit(1);
    }
    let mod;
    try {
        mod = require(abs);
    } catch (err) {
        console.error(`That file did not load as a template module: ${err.message}`);
        process.exit(1);
    }
    const tpl = (mod && typeof mod === 'object' && mod.definition) ? mod
        : (mod && typeof mod === 'object' && mod.template && mod.template.definition) ? mod.template
            : null;
    if (!tpl) {
        console.error('That module exports no template — expected an object with a `definition`.');
        process.exit(1);
    }
    return tpl;
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.list) {
        for (const t of listTemplates()) {
            console.log(`${t.id.padEnd(28)} v${String(t.version).padEnd(3)} ${t.title}`);
        }
        return;
    }
    if (!args.file && !args.id) usage(1);

    const template = args.id ? getTemplate(args.id) : loadFromModule(args.file);
    if (!template) {
        console.error(`No built-in template with id "${args.id}". Try --list.`);
        process.exit(1);
    }

    const { envelope, warnings } = buildExport(template, {
        exportedAt: new Date().toISOString(),
        // No organisation: a module is not a tenant's property the way a
        // captured template is, and a converter has no session to ask. The
        // recipient sees an unclaimed file, which is the honest state of it.
        source: { templateId: template.id || null, version: templateVersion(template) },
    });
    if (!envelope) {
        console.error(`Could not export that template: ${warnings.join(' ')}`);
        process.exit(1);
    }

    // The gate the product will apply, applied here — so "it converted" and
    // "it will import" are the same answer rather than two.
    if (args.check) {
        const verdict = sanitizeImport(JSON.parse(JSON.stringify(envelope)));
        if (!verdict.template) {
            console.error('This template will NOT import:');
            for (const e of verdict.errors) console.error(`  · ${e}`);
            console.error('\nNothing was written. Fix the template, or re-run with --no-check to write it anyway.');
            process.exit(1);
        }
        const r = verdict.report;
        console.error(`✓ imports cleanly — ${r.screens} screens, ${r.actions} actions, ${r.tables} tables, ${r.seededRows} example rows`);
        for (const req of r.requires || []) {
            console.error(`  needs: ${req.kind}${req.ids ? ` (${req.ids.join(', ')})` : ''}${req.count ? ` ×${req.count}` : ''}`);
        }
        for (const w of verdict.warnings.slice(0, 8)) console.error(`  note: ${w}`);
    }
    for (const w of warnings) console.error(`  removed: ${w}`);

    const json = JSON.stringify(envelope, null, 2);
    if (args.stdout) {
        process.stdout.write(`${json}\n`);
        return;
    }
    const out = args.out || exportFilename(template);
    fs.writeFileSync(out, `${json}\n`, 'utf8');
    console.error(`\nWrote ${out} (${Math.round(Buffer.byteLength(json) / 1024)} kB)`);
    console.error('Import it under Studio → Apps → New app → From a file.');
}

if (require.main === module) main();

module.exports = { loadFromModule };
