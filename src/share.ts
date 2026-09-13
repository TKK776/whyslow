/**
 * Share a plan by URL without a server.
 *
 * The plan JSON is deflated and base64url-encoded into the URL fragment, the
 * part after `#`. Browsers never send the fragment to the server, so a shared
 * link carries the whole analysis while the plan itself still goes nowhere.
 *
 * Plans compress well, typically 8 to 12x, because the JSON is mostly repeated
 * key names. A 40kB plan lands around 4kB in the URL, which every browser and
 * chat client handles. Above the limit below we refuse rather than produce a
 * link that silently breaks in Slack.
 */

/** Conservative: Chrome allows ~2MB, but chat clients and some proxies truncate far earlier. */
export const MAX_FRAGMENT_CHARS = 16_000;

const PREFIX = 'p=';

export class ShareTooLargeError extends Error {
  readonly encodedLength: number;

  constructor(encodedLength: number) {
    super(
      `This plan compresses to ${encodedLength.toLocaleString()} characters, past the ` +
        `${MAX_FRAGMENT_CHARS.toLocaleString()} that reliably survives being pasted into ` +
        `chat and email.`,
    );
    this.name = 'ShareTooLargeError';
    this.encodedLength = encodedLength;
  }
}

export function isShareSupported(): boolean {
  return (
    typeof CompressionStream !== 'undefined' &&
    typeof DecompressionStream !== 'undefined'
  );
}

/** Compress and encode plan text for the URL fragment. Excludes the `#`. */
export async function encodeForUrl(planText: string): Promise<string> {
  const compact = compactJson(planText);
  const bytes = await deflate(new TextEncoder().encode(compact));
  const encoded = PREFIX + toBase64Url(bytes);

  if (encoded.length > MAX_FRAGMENT_CHARS) {
    throw new ShareTooLargeError(encoded.length);
  }

  return encoded;
}

/** Read plan text back out of a fragment. Returns null if there is none or it is unreadable. */
export async function decodeFromUrl(fragment: string): Promise<string | null> {
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!raw.startsWith(PREFIX)) return null;

  try {
    const bytes = fromBase64Url(raw.slice(PREFIX.length));
    const inflated = await inflate(bytes);
    return new TextDecoder().decode(inflated);
  } catch {
    return null;
  }
}

/** Strip whitespace from the JSON before compressing. Harmless if it is not JSON. */
function compactJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

async function deflate(input: Uint8Array): Promise<Uint8Array> {
  return pipeThrough(input, new CompressionStream('deflate-raw'));
}

async function inflate(input: Uint8Array): Promise<Uint8Array> {
  return pipeThrough(input, new DecompressionStream('deflate-raw'));
}

async function pipeThrough(
  input: Uint8Array,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  // slice() yields a Uint8Array backed by a plain ArrayBuffer, which Blob requires.
  const stream = new Blob([input.slice()]).stream().pipeThrough(transform);
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded =
    text.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
