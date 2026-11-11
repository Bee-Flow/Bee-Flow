---
title: More components for apps
---

# More components for apps

App Studio has ten more components, more chart types, paging for long lists, row templates, and
more events to react to. An app that does not use them is unchanged. The AI builder knows them and
reads their full description before it uses one.

## New components

| Component | Group | What it does |
|-----------|-------|--------------|
| **Accordion** (`accordion`) | Layout | Collapsible sections. Child number *i* is the body of item *i*. Up to 30 items; `multiple` lets several stay open. |
| **Carousel** (`carousel`) | Layout | Slides shown one at a time. Every child is one slide. Optional dots and looping. |
| **Wizard** (`wizard`) | Layout | Steps shown one at a time with Back and Next, up to 12. Put it inside a form: Next checks the fields of the step on screen with the form's rules before it moves on (turn that off with `validateSteps`), and the form's own submit button sends every step's values at the end. |
| **Avatar** (`avatar`) | Content | A round picture with initials as a fallback. The picture and the name can come from a column. |
| **Gauge** (`gauge`) | Data | A half-circle meter for one value between `min` and `max`, for example an aggregate. Up to 6 `thresholds` colour the arc: each starts at a value and the highest one the value reaches wins. |
| **Tree** (`tree`) | Data | Rows nested under their parent row, with expand and collapse. `parentKey` names the field that holds the parent's id. A row without a parent, or whose parent is not among the rows, is a top-level item. Draws at most `maxDepth` levels (default 6) and `maxNodes` items (default 500); the rest is counted, not drawn. Fires `onRowClick`. |
| **Radio group** (`radio`) | Input | A group of radio buttons. Submits the chosen option value. |
| **Rating** (`rating`) | Input | A star rating with 2 to 10 stars (5 by default). Submits a whole number from 1 to the number of stars. |
| **Slider** (`slider`) | Input | A slider between a minimum and a maximum. Submits a number. |
| **Switch** (`switch`) | Input | An on/off switch. Submits true or false. |

The inputs work like the other inputs of a form (`name`, `label`, `required`, a default or a value
from a binding) and fire `onChange`.

## More chart types

A chart can now be `scatter`, `funnel`, `radar` or `combo` as well as bar, line, area, pie and
donut. In a `combo` chart each series is drawn as `bar`, `line` or `area`, and a series can use a
second value axis on the right.

## Paging long lists

A table, data grid or list can page through a records source instead of showing one page:

- `loadMore` adds the next page under what is shown (table, data grid and list).
- `prevNext` steps from page to page (table and list).

A page is the source's `limit` rows. Left out, the component shows the one page the source reads, as before.

## Rows drawn from your own components

A **list** or a **kanban** can draw each row or card from child components instead of the built-in
body. Inside those children `item` is the row's record and `index` its position, as in a
repeater, so you can bind text with formulas such as `item.title`. The row keeps its click and
drag behaviour, so keep buttons out of a clickable row or card. With no children, the built-in
body is used. The phone always draws the built-in body.

## More events

These components can now start an action on click: callout, card, container, image and stat. These inputs fire an
action when they change: date and time, HTML, person, relation and rich text. A screen can start
actions when it opens or on a timer; see [Logic and steps](./apps-logic.md#triggers-in-the-app).
Any event slot can run a list of actions one after the other; see the same section.

## Smaller additions

- **Images from data.** An image or avatar can show the picture a column resolves to (an https
  address or an uploaded file).
- **Number formats.** Charts, stats and columns take `formatOptions` (currency, decimals, compact numbers, date patterns). See
  [Layout and look](./apps-look.md#richer-text-and-numbers).
- **Rich markdown.** See [Layout and look](./apps-look.md#richer-text-and-numbers).
- **Form validation timing.** A form can show field errors on submit (the default), when a field
  loses focus (`blur`) or on every edit (`change`).

## What the phone draws

The Bee Flow phone app draws a part of the component list itself and leaves the rest to the
browser. The ten components above stay in the browser. So do these older ones: kanban, pivot,
browser view, file preview, PDF compare, document viewer and document compare.

The phone also ignores a few settings: a component's tooltip, its own class name for your stylesheet and its
conditional style. A list or kanban draws its built-in body there. Steps that only make sense in a page (focus,
scroll, clipboard, form and UI steps, back) run only in the browser.
