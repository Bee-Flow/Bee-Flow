// Server modules that scripts import (server/learning/learnMedia.js, server/telemetry/log.js, server/utils/bestEffort.js) pull in
// packages that are only installed under server/. The scripts check does not install the server.
// The server's JSDoc names Express types (import('express').Request ...); here they are any.
declare module 'express' {
    const express: any;
    namespace express {
        type Request = any;
        type Response = any;
        type NextFunction = any;
        type Router = any;
    }
    export = express;
}
declare module 'pino';
declare module '@opentelemetry/api';
