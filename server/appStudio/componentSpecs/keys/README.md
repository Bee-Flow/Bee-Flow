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
keys/binding/<key>.js        a key a record, records, aggregate or dataset binding newly takes
keys/queryShape/<key>.<name>.js  a form the value under a key of a data read newly takes
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

The last two folders describe a data read and carry more than a mark: a binding key brings the
`clean` function the canonicalizer keeps it with, a query shape the `uses` predicate that
recognises the form (or `entryKey: true` and `clean` for a key of a groupBy or aggregates entry).
`../queryMarks.js` checks them and `../README.md` ("A key or a form inside a data read") has the
recipe; for these two the canonicalizer needs no edit.

A **navGroup** mark also carries `toolSchema`, the JSON schema of its value (for example
`{ type: 'string', enum: ['new', 'beta'] }`): `app_set_nav_groups` then offers the key on every
group by itself, after the base keys (`builderTools/navGroupSchema.mts`), and
`builderTools/navGroupSchema.test.js` fails for a marked key without one.

`../README.md` lists every place a mark can sit. A subfolder holds only the marks a feature shipped.
