---
title: Layout and look of an app
---

# Layout and look of an app

This page covers how an app is laid out and how far you can change its look: the grid, style
settings, rules that change a style while a condition holds, themes per app, screen and section,
fonts, the app shell, your own stylesheet, uploaded files and richer text. Everything here is
optional. An app that uses none of it looks exactly as it did before.

The AI builder can set all of this. Describe the look you want, or ask for a change ("make the
hero band dark", "use a serif for headings"). You can also set it by hand in the **Theme** panel
and in the **Style** tab of the inspector.

## Layout: sections, columns and spans

A screen is a vertical stack of **sections**. Each section is a grid of 12 columns, and each
component says how many columns it takes (its **span**, 1 to 12). There are no coordinates, so a
layout cannot overlap or break.

You can now set the width per screen size:

| Setting | Meaning |
|---------|---------|
| `span` | Columns on a wide screen (1024 px and up). |
| `spanMd` | Columns on a tablet (640 to 1023 px). Left out, the automatic rule applies: a span of 1 to 4 takes half the row, 5 to 11 the full row. |
| `spanSm` | Columns on a phone (under 640 px). Left out, the component takes the full row. Set it on one child and that grid keeps its columns on a phone, so two small stats can sit side by side (6 and 6). |
| `columns` | The number of equal columns of one grid, 12 when left out. Works on a section, card, container, form, tab, modal and repeater. Below 12 the automatic tablet rule is off for that grid, so give children a `spanMd` where a tablet needs another split. |
| `responsive` | `auto` (the default) or `manual`. With `manual`, every child keeps its span on a tablet unless it sets `spanMd`. |
| `rowSpan` | How many grid rows a component covers (1 to 6). A tall chart beside two stats can cover two rows. Ignored where the grid stacks on a phone. |
| `alignSelf` | Where a component sits in its row: `stretch` (the default, fills the row's height), `start`, `center` or `end`. |
| `sticky`, `stickyOffset` | `top` or `bottom` keeps a component in view while the page scrolls past its row. It only moves inside its own row, so put it beside taller content, such as a summary card next to a long form. |

A **repeater** repeats its children for every row of a list. It can lay the items out in a stack,
in a grid (`itemColumns`, `itemColumnsMd`, `itemColumnsSm`, 1 to 6 per row) or in one row that
scrolls sideways.

### Section settings

A section can carry more than its components:

- **Title** (`title`, up to 80 characters): a heading at the top of the section.
- **Collapsible**: the viewer folds the section away by clicking its title. Needs a title.
- **Name**: a label only builders see, so you can tell "Filters" from "Results" in the editor.
- **Maximum width** (`maxWidth`): `narrow` (640 px), `medium` (960), `wide` (1280) or `full`. A section is
  never wider than its screen.
- **Only show when** (`visibleWhen`): a condition. A hidden section renders nothing. When the
  condition reads only variables, form values, the current user, the screen, `now` or `today`,
  the data of the components inside is not loaded either.
- **Roles** (`visibleToRoles`): show the section only to people who hold one of these app roles.
  This decides what a role is shown. What a role may read still comes from the table rules.
- **Theme**: see below.

## Style settings

Beyond span and gap, a component can take more style settings. Each works on the types whose
style supports it; the inspector only offers what a component has.

- **Box**: `backgroundColor`, `borderColor`, `borderWidth` (1 to 4 px), `borderSides` (`all`, `top`, `right`,
  `bottom`, `left`, `x`, `y`), `shadow` (`none`, `sm`, `md`, `lg`), `opacity` (10 to 100), `marginTop` and
  `marginBottom` (0 to 8 steps of 4 px).
- **Picture behind a component**: `backgroundImage` (an uploaded file, see below), `backgroundFit`
  (`cover`, `contain`, `tile`) and `backgroundOverlay` (`none`, `dim`, `light`). Put a veil over a
  picture that sits under text: the validator warns about a picture without one.
- **Hover**: `lift`, `tint`, `outline` or `grow`. Use it on a block that is clickable. It does
  nothing on touch screens or when the viewer asks for reduced motion, so never make it the only
  sign that something can be clicked.
- **Text**: `font` (`body`, `heading`, `mono`), `textSize` (`xs` to `4xl`), `lineHeight`, `tracking`,
  `transform` (`uppercase`) and `weight`.

A colour is a **role** (`primary`, `neutral`, `success`, `warning`, `danger`, `info`), a `#rrggbb`
value or `token:<name>` (see Tokens below). A role follows light, dark and high contrast by
itself, so prefer it. A fixed hex colour is the same in every theme, and the validator warns
when text on it would be hard to read.

### Style that depends on a condition

A component can change its style while a formula is true (`styleWhen`): up to 6 rules, each with
a `when` formula and the style to apply. Every rule that is true applies, and a later one wins.

```json
[{ "when": "vars.total > vars.budget", "style": { "color": "danger", "weight": "bold" } }]
```

A rule may only set look settings the component already has (colours, weight, the box and text
settings above). Layout settings such as span, size and margins are never conditional. A formula
that fails leaves the base style. Add rules in the inspector with *Add a rule*.

A table or data grid colours single cells with the **cell style** of a column
(`cellStyle`): up to 6 rules of `{ when, style }` per column, where `item` is the row and `value`
the cell's own value. The cell can take `color`, `backgroundColor` and `weight`.

## Themes

The **app theme** sets the primary and accent colours, the page ground (`canvas`), the corner
radius, the density, the font scale and the appearance (`light`, `dark` or `auto`). An app also
has a design preset. Next to the older ones there are now `grove`, `ember`, `signal`, `bloom`,
`ledger` and `nocturne`. Set the **motion** to `none`, `subtle`, `full` or `expressive`.

New in the **Theme** panel:

- **Theme per screen and per section.** A screen or a section can differ from the app theme in
  any of `primary`, `accent`, `radius`, `density`, `fontScale` and `appearance` (a screen can
  also set `canvas`). Name only what differs. It applies to that screen or section and nothing else,
  for example a dark control-room screen in a light app, or a compact table area. The navigation
  keeps the app theme.
- **Tokens.** Name up to 24 colours or spacings of your own (a spacing is 0 to 96 px). Use a colour
  token anywhere a colour is taken, written `token:<name>`. Change the token once and every place
  that uses it follows. A token is one colour in every theme, like a hex colour. Each token is also
  available to your stylesheet as `--app-token-<name>`.
- **Dark palette.** Give `primary`, `accent` and `canvas` for a dark ground. They replace the
  theme colours while the app is dark (appearance `dark`, or `auto` while the viewer's host theme is
  dark). Use it when the brand colour is too dark to read on a dark ground. It is not applied
  under the high-contrast host theme.
- **Exact radius.** `radiusPx` (0 to 32) sets the corner radius in pixels, finer than the named
  sizes.

## Fonts

Choose a typeface per role: headings, body text and code. The families are `inter`, `satoshi`,
`general-sans`, `cabinet`, `clash-display`, `clash-grotesk`, `fraunces` (a serif), `plex-mono` and `fira-code` (both
monospace). You can also use a WOFF2 font you upload to the app. Every family is served by Bee
Flow itself, so a font never makes a request to another host. A role you leave out keeps today's
look. Set them in the **Fonts per role** section of the Theme panel.

## The app shell

The shell is the frame around the screens: the navigation, the top bar and the footer. In
the shell section of the **Theme** panel you can set:

- **Style**: `tabs`, `sidebar`, `mega`, `rail`, or `none`. `none` draws no navigation at all, for an
  app of one screen or one shown inside another page. The viewer keeps a small menu in the corner
  (account, back to all apps), and other screens are reached through navigate actions and links.
- **Brand**: a name and a logo (an uploaded file or an https address) for the top bar or sidebar. You can show the logo alone.
- **Header**: `hidden` draws no top bar, so the screen starts at the top edge. A small corner menu
  stays, so nobody is shut in.
- **Links**: up to 10 links of your own beside the screens, each to a screen of the app or to an
  http or https address that opens in a new tab.
- **Footer text**: one line of plain text under every screen, up to 120 characters.

Links and footer are not shown on a public page.

## Your own stylesheet

When the theme, tokens and style settings are not enough, an app can carry its own stylesheet
(`design.customCss`, up to 20,000 characters, in the stylesheet section of the **Theme** panel). A component can also get a
class name of your own (`cssClass`, for example `hero`), which your stylesheet reaches as `.u-hero`.

What the stylesheet applies to: the content of every screen of this app, never the navigation
bar and nothing outside the app. The product wraps it so that every rule only matches inside the
app. Use these selectors, they are stable:

| Selector | Matches |
|----------|---------|
| `[data-app-screen="<screen id>"]` | One screen |
| `[data-section-id="<section id>"]` | One section |
| `[data-node-id="<node id>"]` | The cell of one component |
| `[data-app-type="<type>"]` | Every component of a type |
| `.u-<name>` | Every component whose `cssClass` is `<name>` |
| `.bfa-<type>__<part>` | A named part inside a component type that lists parts |

Any other class name of the product can change without notice. For colours prefer the variables
`var(--app-primary)`, `var(--app-accent)`, `var(--app-canvas)`, `var(--text-primary)`, `var(--bg-card)` and
`var(--border-default)`. For a dark variant write `:scope[data-app-dark="true"] .u-hero { … }`.

**Allowed:** ordinary rules, `@media`, `@supports` and `@container`.

**Removed when you save**, and named in the notes the editor and the builder show:

- every other at-rule, such as `@import`, `@font-face`, `@keyframes`, `@layer` and `@scope`;
- `position: fixed`;
- a `url()` that is not `data:image/…` or `asset:<id>` (an uploaded file of this app). No other
  address is accepted, so a stylesheet cannot load anything from outside.

Under the high-contrast theme the stylesheet is not applied at all, so nothing may depend on it to
be readable. A phone ignores the class name.

A public page can have a stylesheet of its own, set with the rest of the public page's look.

## Uploaded files

Upload pictures and fonts to an app once, then use them by name:

- **Types**: PNG, JPEG, WebP, GIF and WOFF2 fonts. SVG is not accepted.
- **Size**: 5 MB per file, 200 files per app, 100 MB per app in total. On self-hosted the total
  is `STUDIO_APP_ASSET_TOTAL_BYTES` (0 = unlimited).
- **Use**: a file is written `asset:<id>`. It works in an image, in the logo and brand, as a
  picture behind a component, as a font and inside the stylesheet. A web address is not accepted
  for a picture behind a component.
- **Rich text**: in markdown, `![alt](asset:<id>)` shows an uploaded picture.

The AI builder lists the uploaded files with `app_list_assets`. It cannot upload a file for you.

## Richer text and numbers

- **Rich markdown.** Turn on `rich` on a markdown component for tables, task lists, block quotes
  and images (uploaded files only). Links are http, https or mailto. Raw HTML never renders.
- **Value format.** In the app settings, **Value format** sets the language, the currency, the
  date style and the time zone the app writes numbers and dates in. One column, chart or stat can
  override it (`formatOptions`: `currency`, `decimals`, `pattern`, `compact`, `percentScale`).
- **Cell templates.** A column with format `template` shows the result of a formula
  (`item.first + " " + item.last`). The result is plain text, never markup. Sorting and filtering
  still use the value under the column's key.
- **Tooltip.** Any component can show a short plain text (up to 200 characters) on hover and
  keyboard focus. A phone ignores it.
- **Variants.** A card can be `plain`, `outlined` or `elevated`; a callout `soft`, `outline` or `solid`;
  a button also has `outline`, `soft` and `link`.

## What stays the same

An app is still data, not code or markup. There is no way to put your own HTML, a script, or
a component of your own on a screen. The look you can change is a closed list of settings, plus a
stylesheet that is scoped to the app and stripped of anything that could load or run something.
