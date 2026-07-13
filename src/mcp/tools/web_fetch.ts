import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable, Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { z } from 'zod';

export const WebFetchSchema = z.object({ url: z.string().min(1) });

export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

export interface PinnedHttpRequest {
  url: URL;
  pinnedAddress: PinnedAddress;
  signal: AbortSignal;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  readTimeoutMs: number;
  maxEncodedBytes: number;
  maxDecodedBytes: number;
}

export interface PinnedHttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Readable;
  destroy(error?: Error): void;
}

export interface WebFetchDeps {
  lookup: (hostname: string) => Promise<readonly PinnedAddress[]>;
  request: (input: PinnedHttpRequest) => Promise<PinnedHttpResponse>;
}

export interface WebFetchResult {
  url: string;
  statusCode: number;
  contentType: string;
  text: string;
  redirects: readonly string[];
}

const MAX_REDIRECTS = 5;
const MAX_ENCODED_BYTES = 2 * 1024 * 1024;
const MAX_DECODED_BYTES = 4 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 10_000;
const BLOCKED_IPV4_RANGES: readonly [number, number][] = [
  [ip4('0.0.0.0'), 8],
  [ip4('10.0.0.0'), 8],
  [ip4('100.64.0.0'), 10],
  [ip4('127.0.0.0'), 8],
  [ip4('169.254.0.0'), 16],
  [ip4('172.16.0.0'), 12],
  [ip4('192.168.0.0'), 16],
  [ip4('224.0.0.0'), 4],
  [ip4('240.0.0.0'), 4],
];
const BLOCKED_IPV4_EXACT = new Set(['169.254.169.254', '255.255.255.255']);
const METADATA_IPV6 = parseIpv6('fd00:ec2::254');

export async function handleWebFetch(args: z.infer<typeof WebFetchSchema>): Promise<string> {
  return JSON.stringify(await webFetch(args.url));
}

export async function webFetch(
  urlText: string,
  deps: WebFetchDeps = {
    lookup: defaultLookup,
    request: defaultPinnedRequest,
  },
): Promise<WebFetchResult> {
  const redirects: string[] = [];
  let current = parsePublicHttpUrl(urlText);
  for (let count = 0; count <= MAX_REDIRECTS; count += 1) {
    const address = chooseValidatedPublicAddress(await deps.lookup(current.hostname));
    const outcome = await executeAttempt(current, address, redirects, deps.request);
    if ('redirectUrl' in outcome) {
      redirects.push(current.toString());
      current = parsePublicHttpUrl(outcome.redirectUrl.toString());
      continue;
    }
    return outcome.result;
  }
  throw new Error('web_fetch: redirect limit exceeded');
}

export function parsePublicHttpUrl(urlText: string): URL {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch (error) {
    throw new Error(
      `web_fetch: invalid URL (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('web_fetch: only http and https URLs are allowed');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('web_fetch: URL credentials are forbidden');
  }
  if (url.hostname.trim() === '') throw new Error('web_fetch: hostname is required');
  return url;
}

export function chooseValidatedPublicAddress(addresses: readonly PinnedAddress[]): PinnedAddress {
  for (const candidate of addresses) {
    const address = validatePinnedAddress(candidate);
    if (address.family === 4 && isBlockedIpv4(address.address)) continue;
    if (address.family === 6 && isBlockedIpv6(address.address)) continue;
    return address;
  }
  throw new Error('web_fetch: no public IP address resolved');
}

async function executeAttempt(
  url: URL,
  pinnedAddress: PinnedAddress,
  redirects: readonly string[],
  request: WebFetchDeps['request'],
): Promise<{ redirectUrl: URL } | { result: WebFetchResult }> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let response: PinnedHttpResponse | undefined;
    let settled = false;
    const cleanup = (): void => {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      if (requestTimer !== undefined) clearTimeout(requestTimer);
    };
    const finish = (value: { redirectUrl: URL } | { result: WebFetchResult }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      controller.abort();
      resolve(value);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      controller.abort();
      response?.destroy();
      reject(error);
    };
    const connectTimer = setTimeout(
      () => fail(new Error(`web_fetch: connect timed out after ${CONNECT_TIMEOUT_MS}ms`)),
      CONNECT_TIMEOUT_MS,
    );
    const requestTimer = setTimeout(
      () => fail(new Error(`web_fetch: request timed out after ${REQUEST_TIMEOUT_MS}ms`)),
      REQUEST_TIMEOUT_MS,
    );

    request({
      url,
      pinnedAddress,
      signal: controller.signal,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      readTimeoutMs: READ_TIMEOUT_MS,
      maxEncodedBytes: MAX_ENCODED_BYTES,
      maxDecodedBytes: MAX_DECODED_BYTES,
    })
      .then(async (incoming) => {
        response = incoming;
        clearTimeout(connectTimer);
        if (settled) {
          incoming.destroy();
          return;
        }
        try {
          if (isRedirect(incoming.statusCode)) {
            const location = getSingleHeader(incoming.headers.location);
            if (location === null) throw new Error('web_fetch: redirect missing location header');
            incoming.destroy();
            finish({ redirectUrl: new URL(location, url) });
            return;
          }
          const result = await decodeAllowedText(url, incoming, redirects, controller.signal);
          finish({ result });
        } catch (error) {
          fail(asError(error));
        }
      })
      .catch((error) => fail(asError(error)));
  });
}

async function decodeAllowedText(
  url: URL,
  response: PinnedHttpResponse,
  redirects: readonly string[],
  signal: AbortSignal,
): Promise<WebFetchResult> {
  const contentType = normalizeContentType(getSingleHeader(response.headers['content-type']));
  if (!isAllowedContentType(contentType)) {
    throw new Error(`web_fetch: unsupported content-type ${contentType || '(missing)'}`);
  }
  const contentEncoding = (getSingleHeader(response.headers['content-encoding']) ?? 'identity')
    .trim()
    .toLowerCase();
  const decoded = await decodeBodyStream(response, contentEncoding, signal);
  return {
    url: url.toString(),
    statusCode: response.statusCode,
    contentType,
    text: decoded.toString('utf8'),
    redirects,
  };
}

async function decodeBodyStream(
  response: PinnedHttpResponse,
  encoding: string,
  signal: AbortSignal,
): Promise<Buffer> {
  if (encoding === 'identity' || encoding === '') {
    return collectIdentityBody(response, signal);
  }
  if (encoding === 'gzip') return collectDecodedBody(response, createGunzip(), encoding, signal);
  if (encoding === 'br')
    return collectDecodedBody(response, createBrotliDecompress(), encoding, signal);
  if (encoding === 'deflate')
    return collectDecodedBody(response, createInflate(), encoding, signal);
  throw new Error(`web_fetch: unsupported content-encoding ${encoding}`);
}

function collectIdentityBody(response: PinnedHttpResponse, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let timer: NodeJS.Timeout | undefined;
    const resetTimer = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(
        () => fail(new Error(`web_fetch: read timed out after ${READ_TIMEOUT_MS}ms`)),
        READ_TIMEOUT_MS,
      );
    };
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      response.body.removeListener('data', onData);
      response.body.removeListener('end', onEnd);
      response.body.removeListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error): void => {
      cleanup();
      response.destroy();
      reject(error);
    };
    const onAbort = (): void => fail(abortError(signal.reason));
    const onError = (error: Error): void => fail(asError(error));
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer | string | Uint8Array): void => {
      resetTimer();
      const buffer = toBuffer(chunk);
      total += buffer.length;
      if (total > MAX_ENCODED_BYTES) {
        fail(new Error(`web_fetch: encoded body exceeds ${MAX_ENCODED_BYTES} bytes`));
        return;
      }
      if (total > MAX_DECODED_BYTES) {
        fail(new Error(`web_fetch: decoded body exceeds ${MAX_DECODED_BYTES} bytes`));
        return;
      }
      chunks.push(buffer);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    response.body.on('error', onError);
    response.body.on('data', onData);
    response.body.on('end', onEnd);
    resetTimer();
  });
}

function collectDecodedBody(
  response: PinnedHttpResponse,
  decoder: Transform,
  encoding: string,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let encodedTotal = 0;
    let decodedTotal = 0;
    let timer: NodeJS.Timeout | undefined;
    const resetTimer = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(
        () => fail(new Error(`web_fetch: read timed out after ${READ_TIMEOUT_MS}ms`)),
        READ_TIMEOUT_MS,
      );
    };
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      response.body.removeListener('data', onEncodedData);
      response.body.removeListener('error', onEncodedError);
      decoder.removeListener('data', onDecodedData);
      decoder.removeListener('end', onEnd);
      decoder.removeListener('error', onDecodedError);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error): void => {
      cleanup();
      response.destroy();
      if (typeof (decoder as { destroy?: () => void }).destroy === 'function') {
        (decoder as { destroy: () => void }).destroy();
      }
      reject(error);
    };
    const onAbort = (): void => fail(abortError(signal.reason));
    const onEncodedError = (error: Error): void => fail(asError(error));
    const onDecodedError = (error: Error): void =>
      fail(new Error(`web_fetch: failed to decode ${encoding} body (${asError(error).message})`));
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onEncodedData = (chunk: Buffer | string | Uint8Array): void => {
      resetTimer();
      encodedTotal += toBuffer(chunk).length;
      if (encodedTotal > MAX_ENCODED_BYTES) {
        fail(new Error(`web_fetch: encoded body exceeds ${MAX_ENCODED_BYTES} bytes`));
      }
    };
    const onDecodedData = (chunk: Buffer | string | Uint8Array): void => {
      resetTimer();
      const buffer = toBuffer(chunk);
      decodedTotal += buffer.length;
      if (decodedTotal > MAX_DECODED_BYTES) {
        fail(new Error(`web_fetch: decoded body exceeds ${MAX_DECODED_BYTES} bytes`));
        return;
      }
      chunks.push(buffer);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    response.body.on('data', onEncodedData);
    response.body.on('error', onEncodedError);
    decoder.on('data', onDecodedData);
    decoder.on('end', onEnd);
    decoder.on('error', onDecodedError);
    response.body.pipe(decoder);
    resetTimer();
  });
}

function normalizeContentType(value: string | null): string {
  if (value === null) return '';
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

function isAllowedContentType(contentType: string): boolean {
  return (
    contentType.startsWith('text/') ||
    contentType === 'application/json' ||
    contentType.endsWith('+json') ||
    contentType === 'application/xml' ||
    contentType === 'text/xml' ||
    contentType.endsWith('+xml')
  );
}

function getSingleHeader(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

function isRedirect(statusCode: number): boolean {
  return (
    statusCode === 301 ||
    statusCode === 302 ||
    statusCode === 303 ||
    statusCode === 307 ||
    statusCode === 308
  );
}

function validatePinnedAddress(address: PinnedAddress): PinnedAddress {
  if (address.family !== 4 && address.family !== 6) {
    throw new Error(
      `web_fetch: invalid resolver family ${String((address as { family?: unknown }).family)}`,
    );
  }
  if (typeof address.address !== 'string' || address.address.trim() === '') {
    throw new Error('web_fetch: invalid resolver address');
  }
  if (address.family === 4) {
    ip4(address.address);
  } else {
    parseIpv6(address.address);
  }
  return address;
}

function isBlockedIpv4(address: string): boolean {
  if (BLOCKED_IPV4_EXACT.has(address)) return true;
  const numeric = ip4(address);
  return BLOCKED_IPV4_RANGES.some(
    ([base, bits]) => numeric >>> (32 - bits) === base >>> (32 - bits),
  );
}

function isBlockedIpv6(address: string): boolean {
  const bytes = parseIpv6(address);
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  if (bytes.every((part) => part === 0)) return true;
  if (bytes.slice(0, 15).every((part) => part === 0) && (bytes[15] ?? 0) === 1) return true;
  if ((first & 0xfe) === 0xfc) return true;
  if (first === 0xfe && (second & 0xc0) === 0x80) return true;
  if (first === 0xfe && (second & 0xc0) === 0xc0) return true;
  if (first === 0xff) return true;
  if (equalBytes(bytes, METADATA_IPV6)) return true;
  if (isIpv4Mapped(bytes)) {
    return isBlockedIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  return false;
}

function isIpv4Mapped(bytes: Uint8Array): boolean {
  return (
    bytes.subarray(0, 10).every((part) => part === 0) && bytes[10] === 0xff && bytes[11] === 0xff
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function ip4(address: string): number {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) {
    throw new Error(`web_fetch: invalid IPv4 address ${address}`);
  }
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    throw new Error(`web_fetch: invalid IPv4 address ${address}`);
  }
  return (
    (((parts[0] ?? 0) << 24) |
      ((parts[1] ?? 0) << 16) |
      ((parts[2] ?? 0) << 8) |
      (parts[3] ?? 0)) >>>
    0
  );
}

function parseIpv6(address: string): Uint8Array {
  if (address.includes('%')) throw new Error(`web_fetch: invalid IPv6 address ${address}`);
  const normalized = address.toLowerCase();
  if (normalized.split('::').length > 2) {
    throw new Error(`web_fetch: invalid IPv6 address ${address}`);
  }
  const [leftRaw, rightRaw] = normalized.split('::');
  const left = parseIpv6Parts(leftRaw ?? '');
  const right = rightRaw === undefined ? [] : parseIpv6Parts(rightRaw);
  const missing = 8 - (left.length + right.length);
  if (rightRaw === undefined) {
    if (missing !== 0) throw new Error(`web_fetch: invalid IPv6 address ${address}`);
  } else if (missing < 1) {
    throw new Error(`web_fetch: invalid IPv6 address ${address}`);
  }
  const zeroGroups: number[] = Array.from({ length: missing }, () => 0);
  const parts = rightRaw === undefined ? left : [...left, ...zeroGroups, ...right];
  if (parts.length !== 8) throw new Error(`web_fetch: invalid IPv6 address ${address}`);
  const bytes = new Uint8Array(16);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) throw new Error(`web_fetch: invalid IPv6 address ${address}`);
    bytes[index * 2] = (part >> 8) & 0xff;
    bytes[index * 2 + 1] = part & 0xff;
  }
  return bytes;
}

function parseIpv6Parts(partial: string): number[] {
  if (partial === '') return [];
  const rawParts = partial.split(':');
  const parts: number[] = [];
  for (let index = 0; index < rawParts.length; index += 1) {
    const part = rawParts[index]!;
    if (part === '') throw new Error(`web_fetch: invalid IPv6 address ${partial}`);
    if (part.includes('.')) {
      if (index !== rawParts.length - 1)
        throw new Error(`web_fetch: invalid IPv6 address ${partial}`);
      const ipv4 = ip4(part);
      parts.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part))
      throw new Error(`web_fetch: invalid IPv6 address ${partial}`);
    parts.push(Number.parseInt(part, 16));
  }
  return parts;
}

async function defaultLookup(hostname: string): Promise<readonly PinnedAddress[]> {
  const resolved = await dnsLookup(hostname, { all: true, verbatim: true });
  return resolved.map((entry) => ({
    address: entry.address,
    family: entry.family as 4 | 6,
  }));
}

async function defaultPinnedRequest(input: PinnedHttpRequest): Promise<PinnedHttpResponse> {
  const client = input.url.protocol === 'https:' ? httpsRequest : httpRequest;
  return await new Promise<PinnedHttpResponse>((resolve, reject) => {
    const req = client(
      {
        protocol: input.url.protocol,
        hostname: input.url.hostname,
        port: input.url.port === '' ? undefined : Number(input.url.port),
        path: `${input.url.pathname}${input.url.search}`,
        method: 'GET',
        agent: false,
        headers: {
          accept:
            'text/*, application/json, application/*+json, application/xml, text/xml, application/*+xml',
          'accept-encoding': 'gzip, br, deflate',
          host: input.url.host,
          connection: 'close',
          'user-agent': 'opensquid-web-fetch/1',
        },
        lookup: (_hostname, _options, callback) =>
          callback(null, input.pinnedAddress.address, input.pinnedAddress.family),
        servername: input.url.hostname,
      },
      (response) => {
        cleanup();
        const destroy = (error?: Error): void => {
          response.destroy(error);
        };
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
          destroy,
        });
      },
    );
    let connectTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      req.destroy(new Error(`web_fetch: connect timed out after ${input.connectTimeoutMs}ms`));
    }, input.connectTimeoutMs);
    let requestTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      req.destroy(new Error(`web_fetch: request timed out after ${input.requestTimeoutMs}ms`));
    }, input.requestTimeoutMs);
    const abort = (): void => {
      req.destroy(abortError(input.signal.reason));
    };
    const clearConnectTimer = (): void => {
      if (connectTimer !== undefined) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
    };
    const cleanup = (): void => {
      clearConnectTimer();
      if (requestTimer !== undefined) {
        clearTimeout(requestTimer);
        requestTimer = undefined;
      }
      input.signal.removeEventListener('abort', abort);
    };
    req.once('socket', (socket) => {
      if ('connecting' in socket && socket.connecting === false) {
        clearConnectTimer();
        return;
      }
      socket.once(input.url.protocol === 'https:' ? 'secureConnect' : 'connect', clearConnectTimer);
      socket.once('error', clearConnectTimer);
    });
    req.once('error', (error) => {
      cleanup();
      reject(asError(error));
    });
    input.signal.addEventListener('abort', abort, { once: true });
    req.end();
  });
}

function toBuffer(chunk: Buffer | string | Uint8Array): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  return Buffer.from(chunk);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('web_fetch: request aborted');
}

export const webFetchInternals = {
  chooseValidatedPublicAddress,
  isBlockedIpv4,
  isBlockedIpv6,
  parseIpv4: ip4,
  parseIpv6,
  parsePublicHttpUrl,
};
