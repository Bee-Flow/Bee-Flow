// ical.js ships typings for its ES build (`export default ICAL`), but the CommonJS
// build the server loads is `module.exports = ICAL`: no `default` key, and
// `require('ical.js').Time` works at runtime. Without this mapping
// (server/jsconfig.json "paths") tsc reports every `ICAL.Time` / `ICAL.parse` as
// missing. Types only: the runtime is untouched.
import ICAL from '../../node_modules/ical.js/dist/types/module.js';
export = ICAL;
