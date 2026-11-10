# AI builder tools added after the base menu

One CommonJS file per tool: `<name>.js`, the file name being the tool name (`app_…`,
lower_snake_case). `../toolRegistry.mts` reads this folder in file-name order at load, refuses a
malformed file (the server does not boot) and documents every field:

```js
// @typecheck strict
'use strict';
module.exports = {
    name: 'app_set_custom_css',          // = the file name
    since: 3,                            // the schema version of the vocabulary it writes
    description: 'Replace the app stylesheet. …',   // the call protocol, as the model reads it
    schema: { type: 'object', properties: { css: { type: ['string', 'null'], description: '…' } }, required: ['css'] },
    apply: (draftWrap, args) => require('./appSetCustomCss.mts').apply(draftWrap, args),
    mutating: true,                      // changes the definition: persisted after the call
    dataModel: false,                    // optional: true when it changes tables, rows, datasets or roles
    core: false,                         // never on the small-model menu
    mcp: true,                           // also offered over the Studio MCP endpoint
    verb: { key: 'studio_apps_<ns>.act_set_custom_css', en: 'Changed the stylesheet' },
};
```

What a file here gets without any other edit:

- **Full band.** The tool joins `TOOL_SCHEMAS` after every base tool (`../schemas.js`), so every
  capable model is offered it and the base schemas keep their bytes and order. A name already on
  the menu is refused.
- **Small band.** Never: `APP_CORE_TOOL_NAMES` (`../../builderModelProfiles.js`) is a fixed list.
- **Dispatch.** `applyToolCall` runs `apply` when the name is none of the base tools (the switch's
  `default`). A throw becomes `{ error }`; answer a rejected call with `{ error, _fixHint }`.
- **Persistence.** `mutating: true` puts the name in `MUTATING_TOOLS` (the chat route and MCP save
  the draft after a successful call, discuss mode refuses it); `dataModel: true` also in
  `DATA_MODEL_TOOLS` (the route sends a `data_model` event). Discuss mode only lets the read
  tools it lists through, so a read-only registry tool is refused there too.
- **MCP.** `mcp: true` lists it on the Studio MCP endpoint with `appId` spliced in and a write
  annotation from `mutating`; `mcp: false` keeps it out of the list and out of `tools/call`.

The file is new server code, so it carries `// @typecheck strict` (scripts/check-new-code-types.mjs);
keep the logic in a `.mts` module next to it and let `apply` call that.

What the package that adds a tool still does:

1. Its i18n namespace pair, `server/i18n/defaults/en/<ns>.js` and `nl/<ns>.json`, holding the
   verb key, then `npm run i18n:gen`.
2. `node scripts/gen-app-catalog.mjs --tools` (from the repository root): the web's tool-name
   list and verb list (`agent-hub/…/AppStudio/chat/appToolNames.generated.json`,
   `appToolVerbs.generated.json`). Commit both.
3. The vocabulary the tool writes is described on its spec entries (`since: 3`), so the model reads
   it in the extension index and through `app_inspect_catalog`.
4. `node --test server/appStudio/builderTools/toolRegistry.contract.test.js` and
   `toolNames.mirror.test.js`; `npx vitest run …/chat/appToolCallDisplay.test.ts` in agent-hub.

`toolRegistry.contract.test.js` holds every file here to these rules. The folder ships empty: the
test-only tools in `../__tests__/registryFixtureTools/` prove the mechanism.
