# Adding to the App Studio catalogue after the frozen base

Every app made before schema version 3 relies on the **base** vocabulary. It never changes.
Whatever is added later carries a **`since: 3`** mark on the place it is declared. The mark does
three things, and nothing else has to be edited for them:

1. **Schema version.** A definition that uses the marked thing is stored with `schemaVersion: 3`;
   one that does not keeps the version it had (`../schemaSince.mts`,
   `../../shared/appDefinition/schemaVersion.mjs`).
2. **Pinned prompt and tool schemas.** The AI builder's prompt renders the base tier only, so its
   text, the catalogue sha256, the prompt ceilings and the pinned tool-schema hashes do not move
   (`../catalogTiers.mts`).
3. **Extension index.** The item is listed in the prompt's generated extension index and served in
   full by `app_inspect_catalog {extensions:[…]}` or `{family:"…"}`
   (`../builderPrompt/extensionIndex.mts`).

## Where the mark goes

| You add | Declare it in | Mark | Index family · name |
|---|---|---|---|
| a component type | `types/<type>.js` (one file) | `since: 3`, `mobile: { reason }`, `description` | `componentTypes` · `<type>` |
| a prop on an existing type | the type's `props` | `since: 3`, `description` on the prop | `props` · `<type>.<prop>` |
| an enum value on an existing prop | the prop's `values` (append) | `valuesSince: { <value>: 3 }` beside `values` | `enumValues` · `<type>.<prop>=<value>` |
| a key of the items of a list prop | the prop's `itemShape` (nested lists too) | `since: 3`, `description` on the key | `itemKeys` · `<type>.<prop>[].<key>` |
| an enum value of an item key | that key's `values` (append) | `valuesSince: { <value>: 3 }` | `enumValues` · `<type>.<prop>[].<key>=<value>` |
| an event on an existing type | the type's `events` (append) | `eventsSince: { <event>: 3 }` on the type | `nodeKeys` · `<type>.<event>` |
| a style knob | `styleKnobGroups/<group>.js` (one file per group) | `since: 3` on the group and on each knob, `description` | `styleKnobs` · `<knob>` |
| an enum value on an existing knob | the knob's `values` (append) | `valuesSince: { <value>: 3 }` | `enumValues` · `style.<knob>=<value>` |
| a step kind | `steps/<kind>.js` (one file) | `since: 3`, `policy`, `childSlots`, `description` | `stepKinds` · `<kind>` |
| a field on an existing step or action kind | the kind's `fields` | `since: 3`, `description` on the field | `stepFields` / `actionFields` · `<kind>.<field>` |
| an enum value on a step or action field | the field's `values` (append) | `valuesSince: { <value>: 3 }` | `enumValues` · `step.<kind>.<field>=<value>` |
| a binding kind | `bindings.js` `BINDING_KINDS` (append) | `BINDING_KIND_SINCE[kind] = 3`, `BINDING_KIND_DOCS[kind]` | `bindingKinds` · `<kind>` |
| a top-level key | `../definitionKeys/<key>.js` (one file) | `since: 3`, `public`, `shape`, `description` | `topLevelKeys` · `<key>` |
| a screen key | `screenSpec.js` `SCREEN_SPEC` | `since: 3`, `description` | `screenKeys` · `screen.<key>` |
| an enum value of a screen key | its `values` (append) | `valuesSince: { <value>: 3 }` | `enumValues` · `screen.<key>=<value>` |
| a theme or design key | `THEME_SPEC` / `DESIGN_SPEC` | `since: 3`, `optional: true`, `description` | `themeKeys` / `designKeys` · `theme.<key>` / `design.<key>` |
| an enum value of a theme or design key | its `values` (append) | `valuesSince: { <value>: 3 }` | `enumValues` · `theme.<key>=<value>` |
| a section key | `keys/section/<key>.js` (one file) | `since: 3`, `shape`, `description` | `sectionKeys` · `section.<key>` |
| a knob newly allowed on sections | `keys/sectionStyle/<knob>.js` + `SECTION_STYLE_KNOBS` | `since: 3`, `description` | `sectionKeys` · `section.style.<knob>` |
| a node key beside props and style (a logic key, a new event name) | `keys/node/<key>.js` | `since: 3`, `shape`, `description` | `nodeKeys` · `node.<key>` |
| a nav key, a nav group key | `keys/nav/<key>.js`, `keys/navGroup/<key>.js` | `since: 3`, `shape`, `description` | `navKeys` · `nav.<key>`, `nav.groups[].<key>` |
| a nav style | `NAV_STYLES` (append) + `keys/nav/style.js` | `valuesSince: { <style>: 3 }` | `enumValues` · `nav.style=<style>` |
| a field type, a filter operator, an aggregate function, a date bucket | the list in `core/dataEngine/dataModel/vocabulary.js` (append) | an entry in `DATA_VOCABULARY_MARKS` (`vocabularySince.js`): `{ since: 3, description }` | `data` · `fieldType.<t>`, `filterOp.<op>`, `aggFn.<fn>`, `dateBucket.<b>` |
| a key of a field declaration (a field option) | the data model code | `DATA_VOCABULARY_MARKS.fieldOptions`: `{ since: 3, shape, description }` | `data` · `fieldOption.<key>` |

A key file under `keys/` only carries the mark (see `keys/README.md`): the canonicalizer and the
validator still have to keep the key.

## Rules every addition follows

- **Append, never insert.** A list keeps its base order; new entries come after it.
- **Optional, emit-when-present.** Nothing new is written into a definition that does not use it.
  The canonicalizer does this itself for a marked prop and a marked step or action field (never
  filled from a default, `null` means not set). A screen, section, node, nav, theme or design key
  is cleaned by its own code, which must leave an absent key absent. A marked prop or field
  cannot be `required`.
- **`description`**: its first sentence is the gloss in the index: at most 72 characters, no `;`,
  no line break. Say more in a second sentence; the whole text is shown with the full entry.
- **A name is one token** of at most 80 characters (no space, comma or semicolon). A component
  type cannot be named `screen`, `section`, `node`, `theme`, `design`, `nav`, `style`, `step`,
  `action`, `fieldType`, `fieldOption`, `filterOp`, `aggFn` or `dateBucket`.
- After a change in `steps/`, `types/` or `styleKnobGroups/`: `npm run gen:shared`.

## What checks it

`../catalogContract.test.js` holds everything that ships to these rules, whether that is nothing or
fifty files, and never needs an edit for a valid addition:

- The base tier is compared, name for name, with `__tests__/baseVocabulary.pin.json`. Vocabulary
  added **without** a mark fails there with its name and the mark to add (instead of as a changed
  prompt hash). Vocabulary added **with** a mark does not touch the pin.
- Every mark is an integer of 3 or more and marks something that exists; every extension item has
  a name and a description the index can print; a step kind answers every execution form and has
  its executor; a type carries `mobile.reason`; a top-level key declares `public`.

`node --test server/appStudio/catalogContract.test.js` (also part of `npm test`).

## Not covered by a mark

There is no `since` for these; adding to them moves the pinned prompt or needs its own decision:
a base knob added to one existing type's `styleKnobs` list (grant knobs by group instead), variable
types, node validation types, toast tones, colour roles, formula functions and scope roots.
