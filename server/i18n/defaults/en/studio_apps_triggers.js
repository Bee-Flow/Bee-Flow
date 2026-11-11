// @typecheck strict
// English GUI defaults — namespace "studio_apps_triggers": every key whose part before the first "." is "studio_apps_triggers".
// Merged into GUI_DEFAULTS by ./index.js, which finds this file by itself (no list to edit). The frontend copy
// (agent-hub/src/i18n/en-defaults.js) is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
// Dutch: ../nl/studio_apps_triggers.json. App Studio client triggers added in schema 3: the "then also run" list of an
// event slot, a screen's Triggers (onOpen, timers), the watchers in the Logic tab and the runtime notice of a paused watcher.
module.exports = {
    "studio_apps_triggers.runtime.watcher_paused": "A watcher of this app ran too often and was paused: \"{id}\". Reload the page to start it again.",
    "studio_apps_triggers.screen.add_timer": "Add a timer",
    "studio_apps_triggers.screen.every_seconds": "Every how many seconds",
    "studio_apps_triggers.screen.no_actions": "Add an action to the app first: a trigger runs one of its actions.",
    "studio_apps_triggers.screen.nothing": "Nothing",
    "studio_apps_triggers.screen.on_open": "When the screen opens",
    "studio_apps_triggers.screen.on_open_aria": "Action when the screen opens",
    "studio_apps_triggers.screen.on_open_hint": "Runs each time someone opens this screen in the app. Not in the editor.",
    "studio_apps_triggers.screen.remove_timer": "Remove this timer",
    "studio_apps_triggers.screen.seconds_run": "s, run",
    "studio_apps_triggers.screen.timer_action": "Action of this timer",
    "studio_apps_triggers.screen.timers": "Timers",
    "studio_apps_triggers.screen.timers_hint": "Run an action every few seconds while the screen is open and the browser tab is visible.",
    "studio_apps_triggers.screen.title": "Triggers",
    "studio_apps_triggers.slot.add": "Then also run another action",
    "studio_apps_triggers.slot.extra_action": "Action {n} of this event",
    "studio_apps_triggers.slot.remove": "Do not run this one",
    "studio_apps_triggers.slot.stops": "If one of them fails, the ones after it do not run.",
    "studio_apps_triggers.slot.then_also": "Then also run, in this order",
    "studio_apps_triggers.watchers.action": "Action to run",
    "studio_apps_triggers.watchers.add": "Add a watcher",
    "studio_apps_triggers.watchers.debounce": "Wait this many milliseconds of quiet first",
    "studio_apps_triggers.watchers.desc": "A watcher runs an action each time the value of its formula changes, in the app itself. One that runs more than ten times a minute is paused.",
    "studio_apps_triggers.watchers.expr": "Formula to watch",
    "studio_apps_triggers.watchers.remove": "Remove this watcher",
    "studio_apps_triggers.watchers.title": "When a value changes",
};
