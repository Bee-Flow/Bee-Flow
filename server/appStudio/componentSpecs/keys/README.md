# Key marks

The `since` marks of keys that have no spec table of their own: a **section** key, a **node** key
beside `props` and `style` (a logic key such as a conditional style, a new event name), a **nav**
key and a nav **group** key. They are cleaned by hand-written canonicalizer code, so this folder
is where their mark lives. One file per key, named exactly as a definition spells the key:

```
keys/section/<key>.js        a key of a section beside id, style and children
keys/sectionStyle/<knob>.js  a style knob (of STYLE_KNOBS) a section may newly carry
keys/node/<key>.js           a key of a component node beside id, type, props, style, children
keys/nav/<key>.js            a key of definition.nav
keys/navGroup/<key>.js       a key of one entry of definition.nav.groups
```

```js
'use strict';
module.exports = {
    since: 3,                                   // a NEW key
    shape: 'string ≤80',                        // the value, as catalogue text (not for sectionStyle)
    description: 'A title shown above the section. Empty hides it.',
};
```

A base key that gained enum values carries `valuesSince` instead of `since` (the only case today is
a nav style: append it to `NAV_STYLES` and mark it in `keys/nav/style.js`):

```js
module.exports = { valuesSince: { dock: 3 }, shape: 'tabs|sidebar|mega|rail|dock', description: 'dock pins the screens to the bottom edge.' };
```

`../keyMarks.js` reads the folder at load and refuses an incomplete file. The mark makes a
definition that uses the key schema version 3 and lists the key for the AI builder
(`section.<key>`, `node.<key>`, `nav.<key>`, `nav.groups[].<key>`, `section.style.<knob>`). It does
**not** make the key legal: `canonicalize/` has to keep it (a section key is one entry of
`SECTION_OPTIONAL_KEYS` in `canonicalize/screens.js`) and `validate/` has to check it.

`../README.md` lists every place a mark can sit. The subfolders ship empty.
