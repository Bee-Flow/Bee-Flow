// Properties this code hangs on Node's own types (errors carry a code and an HTTP status,
// requests carry what the middleware attached). Declared once here, not cast at every use.
import 'node:http';

declare global {
  interface Error {
    code?: string;
    status?: number;
    remediation?: string;
    attemptsLeft?: number;
  }
}

declare module 'node:http' {
  interface IncomingMessage {
    body?: any;
    beeflow?: any;
    req?: IncomingMessage;
    __beeflowRetried?: boolean;
    __shellNext?: () => void;
  }
}

export {};
