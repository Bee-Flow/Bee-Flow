/**
 * The voice turn's multipart body, built by hand.
 *
 * Not paranoia: expo/fetch's FormData converter documents that a React Native
 * `{uri, name, type}` part is NOT supported (expo/src/winter/fetch/
 * convertFormData.ts), and the alternatives it does support leave the part's
 * Content-Type up to whatever the runtime infers from the extension. multer is
 * configured to reject any part whose mimetype does not start with `audio/`
 * (voice.js:67), so an inferred `application/octet-stream` fails the turn with
 * an error the user cannot act on. Assembling the bytes here makes the header
 * ours. A turn is at most ~60s of 64 kbit/s mono — half a megabyte — so
 * holding it in memory costs nothing.
 */

export type MultipartPart =
    | { kind: 'field'; name: string; value: string }
    | {
          kind: 'file';
          name: string;
          filename: string;
          contentType: string;
          bytes: Uint8Array;
      };

export function field(name: string, value: string): MultipartPart {
    return { kind: 'field', name, value };
}

function headerOf(part: MultipartPart, boundary: string): string {
    if (part.kind === 'field') {
        return `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n`;
    }
    return (
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
        `Content-Type: ${part.contentType}\r\n\r\n`
    );
}

/**
 * `Uint8Array<ArrayBuffer>`, not a bare `Uint8Array`: since TypeScript 5.7 the
 * typed arrays are generic over their backing buffer, and the bare form widens
 * to `Uint8Array<ArrayBufferLike>` — which `BodyInit` does not accept, because a
 * SharedArrayBuffer-backed view cannot be sent. The array built here is
 * `new Uint8Array(total)` and so is genuinely ArrayBuffer-backed.
 */
export function buildMultipart(
    parts: MultipartPart[],
    // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator -- a multipart boundary only has to be absent from the body; it is not a secret
    boundary = `----BeeFlowVoice${Math.random().toString(36).slice(2, 18)}`,
): { bytes: Uint8Array<ArrayBuffer>; contentType: string } {
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];

    for (const part of parts) {
        chunks.push(
            encoder.encode(headerOf(part, boundary)),
            part.kind === 'field' ? encoder.encode(part.value) : part.bytes,
            encoder.encode('\r\n'),
        );
    }
    chunks.push(encoder.encode(`--${boundary}--\r\n`));

    const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return { bytes, contentType: `multipart/form-data; boundary=${boundary}` };
}
