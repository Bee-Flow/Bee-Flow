// Packages the server uses that ship no typings, or whose @types package is a
// different major than the installed runtime (better-sqlite3 13 vs @types 9,
// dockerode 5 vs 4, sodium-native 5 vs 2, connect-pg-simple 10 vs 7): typings
// of another major would report errors that are not real. Declared here as
// untyped modules so the typecheck can mark their importers; the call sites
// type what they read with local typedefs. express-session and multer are
// here too: their @types would replace the request/session shape that
// types/express.d.ts declares for the whole server. Types only, for tsc.
declare module 'better-sqlite3';
declare module 'dockerode';
declare module 'sodium-native';
declare module 'connect-pg-simple';
declare module 'pdfkit';
declare module 'fontkit';
declare module 'occt-import-js';
declare module 'vcf';
declare module 'express-session';
declare module 'multer';
