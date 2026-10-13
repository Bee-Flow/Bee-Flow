/**
 * The react-mui light tier's preview document: pinned esm.sh runtime, import
 * map, the esbuild virtual-filesystem plugin, the runtime guard, the asset
 * resolver and the document shell. One source for the web editor's preview
 * (agent-hub/src/utils/buildWebpagePreview.js, esbuild-wasm in the browser,
 * through the generated mirror agent-hub/src/shared/webpage/) and the
 * server's twin (services/reactBundleServer.js, native esbuild, for the
 * headless screenshot, the public React share and the phone's draft
 * document), so a screenshot shows what the live preview shows.
 *
 * The bundler is passed in: esbuild's onResolve/onLoad API is the same in
 * esbuild-wasm and native esbuild, and how each side obtains it is its own.
 *
 * Edit this file, never the mirror; then run `npm run gen:shared`.
 * server/shared/webpage/previewDocument.pin.test.mjs pins every document built
 * from it.
 */

import { defangScriptClose } from './previewInline.mjs';

// Pinned runtime versions. Bump together. The '*' external prefix on a package
// (below) tells esm.sh to leave that package's deps as bare imports, which
// resolve back through THIS import map — guaranteeing a single shared
// react / react-dom / emotion instance (the #1 MUI-over-CDN failure mode).
const REACT_VERSION = '18.3.1';
const MUI_VERSION = '5.16.7';
const MUI_ICONS_VERSION = '5.16.7';
const EMOTION_REACT_VERSION = '11.13.5';
const EMOTION_STYLED_VERSION = '11.13.5';
const ESM_BASE = 'https://esm.sh';

export const REACT_ENTRY = 'src/main.jsx';

/**
 * The import map injected into the preview document. Maps the importable
 * packages to pinned esm.sh URLs; the leading '*' externalises each package's
 * deps so they share the single react/emotion above.
 */
// react, react-dom and emotion are the SINGLETONS that every module must share
// (hooks + the emotion cache break with duplicates). They stay bare imports
// resolved by the import map below. Everything else (@mui/*, and their
// transitive deps clsx / @babel/runtime / react-is / @popperjs/core …) is
// rewritten to a pinned esm.sh URL with ?external=<singletons>, so esm.sh
// bundles those transitive deps itself (as absolute esm.sh URLs) and only the
// singletons leak out as bare imports. (The previous `*`-prefix externalised
// ALL deps, including clsx — which the import map didn't cover, so the whole
// graph failed to load and the page rendered blank.)
const EXTERNAL_SINGLETONS = 'react,react-dom,@emotion/react,@emotion/styled';

export function buildImportMap() {
    return {
        imports: {
            'react': `${ESM_BASE}/react@${REACT_VERSION}`,
            'react/': `${ESM_BASE}/react@${REACT_VERSION}/`,
            'react-dom': `${ESM_BASE}/react-dom@${REACT_VERSION}?external=react`,
            'react-dom/client': `${ESM_BASE}/react-dom@${REACT_VERSION}/client?external=react`,
            '@emotion/react': `${ESM_BASE}/@emotion/react@${EMOTION_REACT_VERSION}?external=react`,
            '@emotion/react/jsx-runtime': `${ESM_BASE}/@emotion/react@${EMOTION_REACT_VERSION}/jsx-runtime?external=react`,
            '@emotion/styled': `${ESM_BASE}/@emotion/styled@${EMOTION_STYLED_VERSION}?external=react,@emotion/react`,
        },
    };
}

// A specifier is a shared singleton (kept bare → import map) vs. anything else
// (rewritten to a pinned esm.sh URL).
export function isSharedSingleton(spec) {
    return spec === 'react' || spec.startsWith('react/')
        || spec === 'react-dom' || spec.startsWith('react-dom/')
        || spec === '@emotion/react' || spec.startsWith('@emotion/react/')
        || spec === '@emotion/styled' || spec.startsWith('@emotion/styled/');
}

const MUI_PINS = {
    '@mui/material': `@mui/material@${MUI_VERSION}`,
    '@mui/icons-material': `@mui/icons-material@${MUI_ICONS_VERSION}`,
    '@mui/system': `@mui/system@${MUI_VERSION}`,
    '@mui/lab': '@mui/lab@5.0.0-alpha.173',
    '@mui/base': '@mui/base@5.0.0-beta.40',
    '@mui/utils': '@mui/utils@5.16.6',
};
export function pinnedSpec(spec) {
    for (const k of Object.keys(MUI_PINS)) {
        if (spec === k) return MUI_PINS[k];
        if (spec.startsWith(k + '/')) return MUI_PINS[k] + spec.slice(k.length);
    }
    return spec; // unknown package → esm.sh resolves latest (light tier supports the MUI core set)
}
export function esmExternalUrl(spec) {
    return `${ESM_BASE}/${pinnedSpec(spec)}?external=${EXTERNAL_SINGLETONS}`;
}

// ── Virtual filesystem resolution ──────────────────────────────────────────

const LOADER_BY_EXT = {
    jsx: 'jsx', tsx: 'tsx', ts: 'ts', mjs: 'js', cjs: 'js', js: 'jsx', json: 'json',
};
function loaderForPath(path) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    return LOADER_BY_EXT[ext] || 'text';
}

function dirname(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
function normalize(p) {
    const parts = [];
    for (const seg of p.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') parts.pop();
        else parts.push(seg);
    }
    return parts.join('/');
}

/**
 * Resolve a relative/absolute import against the in-memory file map, trying the
 * exact path then common extensions and index files. Returns the matched key or
 * null. Bare (npm) specifiers are handled separately (externalised).
 */
export function resolveImport(importer, spec, files) {
    const base = spec.startsWith('/')
        ? normalize(spec.slice(1))
        : normalize((importer ? dirname(importer) + '/' : '') + spec);
    const candidates = [
        base,
        base + '.jsx', base + '.js', base + '.tsx', base + '.ts', base + '.mjs', base + '.json', base + '.css',
        base + '/index.jsx', base + '/index.js', base + '/index.tsx', base + '/index.ts',
    ];
    for (const c of candidates) {
        if (Object.prototype.hasOwnProperty.call(files, c)) return c;
    }
    return null;
}

function cssInjectModule(css) {
    return `const __c=${JSON.stringify(css)};const __s=document.createElement('style');__s.setAttribute('data-beeflow','imported-css');__s.textContent=__c;document.head.appendChild(__s);`;
}

/**
 * esbuild plugin backing the in-browser bundle with the project's file map.
 * files: { [path]: { isText, content?, dataUrl? } }
 */
export function virtualFsPlugin(files) {
    return {
        name: 'beeflow-virtual-fs',
        setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
                if (args.kind === 'entry-point') {
                    const resolved = resolveImport('', args.path, files);
                    if (!resolved) return { errors: [{ text: `Entry point not found: ${args.path}` }] };
                    return { path: resolved, namespace: 'vfs' };
                }
                // Bare specifier (npm package) → external. Singletons stay bare
                // (resolved by the import map); everything else is rewritten to a
                // pinned esm.sh URL so its transitive deps resolve via esm.sh.
                if (!args.path.startsWith('.') && !args.path.startsWith('/')) {
                    if (isSharedSingleton(args.path)) return { path: args.path, external: true };
                    return { path: esmExternalUrl(args.path), external: true };
                }
                const resolved = resolveImport(args.importer, args.path, files);
                if (!resolved) {
                    return { errors: [{ text: `Cannot resolve "${args.path}" from "${args.importer || 'entry'}". Create that file (imports must include the extension, e.g. './App.jsx').` }] };
                }
                return { path: resolved, namespace: 'vfs' };
            });

            build.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => {
                const entry = files[args.path];
                if (!entry) return { errors: [{ text: `File not found: ${args.path}` }] };
                if (/\.css$/i.test(args.path)) {
                    return { contents: cssInjectModule(entry.content || ''), loader: 'js' };
                }
                if (entry.isText) {
                    return { contents: entry.content || '', loader: loaderForPath(args.path) };
                }
                // Binary asset imported as a module → resolve to its data: URL so
                // `import logoUrl from './assets/logo.png'` yields a usable string.
                return { contents: `export default ${JSON.stringify(entry.dataUrl || '')};`, loader: 'js' };
            });
        },
    };
}

/**
 * Bundle the react-mui project into a single ESM string with `esbuild`
 * (esbuild-wasm or native). Throws an Error whose `.formatted` carries
 * readable esbuild diagnostics on failure.
 */
export async function bundleReact(esbuild, { entry = REACT_ENTRY, files }) {
    let result;
    try {
        result = await esbuild.build({
            entryPoints: [entry],
            bundle: true,
            format: 'esm',
            jsx: 'automatic',
            write: false,
            logLevel: 'silent',
            target: 'es2020',
            plugins: [virtualFsPlugin(files)],
        });
    } catch (e) {
        const msgs = Array.isArray(e?.errors) && e.errors.length
            ? e.errors.map((x) => x.text).join('\n')
            : (e?.message || String(e));
        const err = new Error('esbuild bundle failed');
        err.formatted = msgs;
        throw err;
    }
    const out = result.outputFiles && result.outputFiles[0];
    return { code: out ? out.text : '', warnings: result.warnings || [] };
}

// ── Document assembly ──────────────────────────────────────────────────────

// The live preview paints a panel when nothing rendered after 4 s.
const PREVIEW_EMPTY_FALLBACK = `  setTimeout(function(){
    show('The app loaded but rendered nothing',
      'No React output appeared in #root. This usually means a failed import (React/MUI from the CDN) or a component returned nothing. Open the browser console for the exact error.');
  }, 4000);`;

// The headless render (screenshot, public share) leaves that fallback out.
const HEADLESS_NO_FALLBACK = `  // NOTE: unlike the client preview, the SERVER render intentionally OMITS the
  // timed "rendered nothing" fallback — the screenshot service controls timing
  // and waits for a real mount, so a slow (cold esm.sh) MUI load must not be
  // painted as a false error. The error handlers above still catch real crashes.`;

/**
 * Classic inline script injected BEFORE the module so a failed esm.sh import /
 * React runtime throw / app exception becomes a readable panel in #root instead
 * of a silent blank page. Registers global error + unhandledrejection handlers
 * (so it catches module-eval failures), and a fallback that fires if nothing
 * rendered and no error surfaced. Only overrides #root when it's still empty —
 * a successful render is never clobbered.
 *
 * `headless` (the server's screenshot and public React share) marks the panel
 * with data-beeflow-guard and OMITS the timed "rendered nothing" fallback: the
 * screenshot service controls timing and waits for a real mount, so a slow
 * (cold esm.sh) MUI load must not be painted as a false error.
 */
export function runtimeGuardScript({ headless = false } = {}) {
    return `<script>(function(){
  var shown = false;
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function rootEmpty(){ var r=document.getElementById('root'); return r && (!r.children || r.children.length===0); }
  function show(title, detail){
    if (shown || !rootEmpty()) return; shown = true;
    var r = document.getElementById('root');
    r.innerHTML = '<div${headless ? ' data-beeflow-guard="1"' : ''} style="position:fixed;inset:0;display:flex;align-items:flex-start;justify-content:center;padding:24px;background:#fef2f2;color:#b91c1c;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:auto">'
      + '<div style="max-width:680px;width:100%"><div style="font-weight:600;margin-bottom:8px">'+esc(title)+'</div>'
      + (detail ? '<pre style="white-space:pre-wrap;word-break:break-word;margin:0">'+esc(detail)+'</pre>' : '')
      + '</div></div>';
  }
  window.addEventListener('error', function(e){
    var where = e && e.filename ? ' ('+e.filename+(e.lineno?':'+e.lineno:'')+')' : '';
    show('The app crashed while loading', ((e && e.message) || 'Script error') + where);
  }, true);
  window.addEventListener('unhandledrejection', function(e){
    var reason = e && e.reason; show('Unhandled error', (reason && (reason.stack || reason.message)) || String(reason));
  });
${headless ? HEADLESS_NO_FALLBACK : PREVIEW_EMPTY_FALLBACK}
})();<\/script>`;
}

/**
 * Classic inline script that resolves RUNTIME string asset references — e.g.
 * `<img src="assets/logo.jpg">` written directly in JSX — to the project's
 * binary data: URLs. The esbuild bundler only rewrites assets imported as ES
 * modules (`import logo from './assets/logo.png'`); a plain string `src` is
 * invisible to it and would 404 in the sandboxed (no-origin) iframe. This
 * patches existing nodes, watches React's renders via MutationObserver, and
 * catches a failed <img> load in the capture phase (before the app's own
 * onError can hide it). Mirrors the vanilla preview's compose-time
 * inlineDataUrl(), but at runtime because React builds the DOM itself.
 */
export function assetResolverScript(assetMap) {
    if (!assetMap || Object.keys(assetMap).length === 0) return '';
    return `<script>(function(){
  var M = ${JSON.stringify(assetMap)};
  function lookup(u){
    if(!u) return null;
    u = String(u);
    var low = u.toLowerCase();
    if(low.indexOf('data:')===0 || low.indexOf('blob:')===0 || low.indexOf('http')===0 || low.indexOf('//')===0) return null;
    var key = u.split('?')[0].split('#')[0];
    if(key.indexOf('./')===0) key = key.slice(2);
    while(key.indexOf('/')===0) key = key.slice(1);
    if(M[key]) return M[key];
    if(M['assets/'+key]) return M['assets/'+key];
    var seg = key.split('/').pop();
    if(seg && M['assets/'+seg]) return M['assets/'+seg];
    return null;
  }
  function fixEl(el){
    if(!el || el.nodeType!==1 || !el.getAttribute) return;
    var s = el.getAttribute('src');
    if(s){ var d=lookup(s); if(d && d!==s) el.setAttribute('src', d); }
    if(el.tagName==='LINK'){ var h=el.getAttribute('href'); if(h){ var dh=lookup(h); if(dh) el.setAttribute('href', dh); } }
    var st = el.getAttribute('style');
    if(st && st.indexOf('url(')>-1){
      var ns = st.replace(/url\\(([^)]*)\\)/g, function(m,p){ var c=p.replace(/['"]/g,'').trim(); var du=lookup(c); return du?('url('+du+')'):m; });
      if(ns!==st) el.setAttribute('style', ns);
    }
  }
  function scan(root){ try{ fixEl(root); if(root.querySelectorAll){ var all=root.querySelectorAll('[src],link[href],[style]'); for(var i=0;i<all.length;i++) fixEl(all[i]); } }catch(e){} }
  try{
    var mo = new MutationObserver(function(muts){ for(var i=0;i<muts.length;i++){ var m=muts[i]; if(m.type==='attributes') fixEl(m.target); var an=m.addedNodes; if(an) for(var j=0;j<an.length;j++) scan(an[j]); } });
    function start(){ scan(document); try{ mo.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src','href','style']}); }catch(e){} }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', start); else start();
  }catch(e){}
  // Backup: rewrite a failed <img> in the capture phase, before the app's onError.
  document.addEventListener('error', function(e){
    var t = e.target;
    if(t && t.tagName==='IMG'){ var d=lookup(t.getAttribute('src')); if(d && t.getAttribute('src')!==d){ t.setAttribute('src', d); } }
  }, true);
})();<\/script>`;
}

export function shellDoc({ headScripts, importMap, bodyHtml }) {
    return `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${headScripts}
<script type="importmap">${JSON.stringify(importMap)}<\/script>
<style>html,body{height:100%;margin:0}#root{min-height:100%}body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}</style>
</head><body>
${bodyHtml}
</body></html>`;
}

/**
 * The <body> of a bundled react-mui document: #root, the runtime guard, the
 * asset resolver, any `extraScripts` (one line each; the web preview passes
 * its selection relay, '' when it is off), then the bundle as one inline
 * module with every `</script` defanged.
 */
export function reactBodyHtml({ bundle, assetMap, headless = false, extraScripts = [] }) {
    return [
        '<div id="root"></div>',
        runtimeGuardScript({ headless }),
        assetResolverScript(assetMap),
        ...extraScripts,
        '<script type="module">',
        defangScriptClose(bundle),
        '<\/script>',
    ].join('\n');
}
