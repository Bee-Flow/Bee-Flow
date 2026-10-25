// Server modules that scripts import (server/learning/learnMedia.js, server/telemetry/log.js) pull in
// packages that are only installed under server/. The scripts check does not install the server.
declare module 'express';
declare module 'pino';
