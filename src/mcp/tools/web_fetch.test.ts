import { PassThrough } from 'node:stream';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webFetch, webFetchInternals } from './web_fetch.js';
import type { PinnedAddress, PinnedHttpRequest, PinnedHttpResponse } from './web_fetch.js';

const PUBLIC_V4: PinnedAddress = { address: '93.184.216.34', family: 4 };
const PUBLIC_V6: PinnedAddress = { address: '2001:4860:4860::8888', family: 6 };
const ENCODED_CAP = 2 * 1024 * 1024;
const DECODED_CAP = 4 * 1024 * 1024;

afterEach(() => vi.useRealTimers());

function streamedResponse(
  input: {
    statusCode?: number;
    headers?: Record<string, string | string[] | undefined>;
    chunks?: readonly Buffer[];
  } = {},
): PinnedHttpResponse {
  const body = new PassThrough();
  queueMicrotask(() => {
    for (const chunk of input.chunks ?? []) body.write(chunk);
    body.end();
  });
  return {
    statusCode: input.statusCode ?? 200,
    headers: input.headers ?? { 'content-type': 'text/plain' },
    body,
    destroy: (error?: Error) => body.destroy(error),
  };
}

describe('web_fetch address validation', () => {
  it('rejects URL credentials', async () => {
    await expect(webFetch('https://user:pass@example.com')).rejects.toThrow(/credentials/);
  });

  it('blocks every required private/metadata IP class and preserves public IPv4/IPv6 forms', () => {
    const blocked: PinnedAddress[] = [
      { address: '127.0.0.1', family: 4 },
      { address: '10.0.0.1', family: 4 },
      { address: '100.64.0.1', family: 4 },
      { address: '169.254.1.1', family: 4 },
      { address: '169.254.169.254', family: 4 },
      { address: '172.16.0.1', family: 4 },
      { address: '192.168.0.1', family: 4 },
      { address: '224.0.0.1', family: 4 },
      { address: '255.255.255.255', family: 4 },
      { address: '::', family: 6 },
      { address: '::1', family: 6 },
      { address: '0:0:0:0:0:0:0:1', family: 6 },
      { address: 'fc00::1', family: 6 },
      { address: 'fd12:3456::1', family: 6 },
      { address: 'fe80::1', family: 6 },
      { address: 'ff02::1', family: 6 },
      { address: 'fec0::1', family: 6 },
      { address: 'fd00:ec2::254', family: 6 },
      { address: '::ffff:127.0.0.1', family: 6 },
      { address: '::ffff:7f00:1', family: 6 },
      { address: '0:0:0:0:0:ffff:7f00:1', family: 6 },
      { address: '::ffff:169.254.169.254', family: 6 },
    ];
    for (const address of blocked) {
      expect(() => webFetchInternals.chooseValidatedPublicAddress([address])).toThrow(/public IP/);
    }

    expect(webFetchInternals.chooseValidatedPublicAddress([PUBLIC_V4])).toEqual(PUBLIC_V4);
    expect(webFetchInternals.chooseValidatedPublicAddress([PUBLIC_V6])).toEqual(PUBLIC_V6);
    expect(
      webFetchInternals.chooseValidatedPublicAddress([{ address: '::ffff:8.8.8.8', family: 6 }]),
    ).toEqual({ address: '::ffff:8.8.8.8', family: 6 });
    expect(
      webFetchInternals.chooseValidatedPublicAddress([{ address: '::ffff:0808:0808', family: 6 }]),
    ).toEqual({ address: '::ffff:0808:0808', family: 6 });
  });

  it('rejects malformed resolver answers instead of silently skipping them', () => {
    const malformed = [
      { address: '300.1.1.1', family: 4 },
      { address: 'gggg::1', family: 6 },
      { address: '::ffff:300.1.1.1', family: 6 },
      { address: '93.184.216.34', family: 5 },
    ] as unknown as PinnedAddress[];
    for (const answer of malformed) {
      expect(() => webFetchInternals.chooseValidatedPublicAddress([answer])).toThrow(
        /invalid resolver|invalid IPv/,
      );
    }
  });
});

describe('web_fetch request/redirect policy', () => {
  it('re-resolves every redirect, preventing DNS rebinding across hops', async () => {
    const lookups: string[] = [];
    const requests: string[] = [];
    await expect(
      webFetch('https://example.com/start', {
        lookup: (hostname) => {
          lookups.push(hostname);
          return Promise.resolve(
            hostname === 'example.com' ? [PUBLIC_V4] : [{ address: '127.0.0.1', family: 4 }],
          );
        },
        request: (input) => {
          requests.push(`${input.url.hostname}@${input.pinnedAddress.address}`);
          return Promise.resolve(
            streamedResponse({
              statusCode: 302,
              headers: { location: 'https://redirect.example/next' },
            }),
          );
        },
      }),
    ).rejects.toThrow(/public IP/);
    expect(lookups).toEqual(['example.com', 'redirect.example']);
    expect(requests).toEqual(['example.com@93.184.216.34']);
  });

  it('enforces the redirect limit', async () => {
    await expect(
      webFetch('https://example.com/start', {
        lookup: () => Promise.resolve([PUBLIC_V4]),
        request: (input) =>
          Promise.resolve(
            streamedResponse({
              statusCode: 302,
              headers: { location: `${input.url.origin}/again` },
            }),
          ),
      }),
    ).rejects.toThrow(/redirect limit/);
  });

  it('rejects unsupported content types', async () => {
    await expect(
      webFetch('https://example.com/', {
        lookup: () => Promise.resolve([PUBLIC_V4]),
        request: () =>
          Promise.resolve(
            streamedResponse({
              headers: { 'content-type': 'image/png' },
              chunks: [Buffer.from('png')],
            }),
          ),
      }),
    ).rejects.toThrow(/content-type/);
  });

  it('returns text payloads and threads the pinned address into the request layer', async () => {
    const seen: PinnedHttpRequest[] = [];
    const result = await webFetch('https://example.com/data', {
      lookup: () => Promise.resolve([PUBLIC_V4]),
      request: (input) => {
        seen.push(input);
        return Promise.resolve(
          streamedResponse({
            headers: { 'content-type': 'application/json' },
            chunks: [Buffer.from('{"ok":true}', 'utf8')],
          }),
        );
      },
    });
    expect(seen[0]?.pinnedAddress).toEqual(PUBLIC_V4);
    expect(result).toEqual({
      url: 'https://example.com/data',
      statusCode: 200,
      contentType: 'application/json',
      text: '{"ok":true}',
      redirects: [],
    });
  });
});

describe('web_fetch streaming size limits', () => {
  it('enforces the encoded cap during streaming', async () => {
    await expect(
      webFetch('https://example.com/encoded', {
        lookup: () => Promise.resolve([PUBLIC_V4]),
        request: () =>
          Promise.resolve(
            streamedResponse({
              chunks: [Buffer.alloc(ENCODED_CAP), Buffer.alloc(1)],
            }),
          ),
      }),
    ).rejects.toThrow(/encoded body exceeds/);
  });

  it('enforces decoded caps during streaming for gzip, br, and deflate', async () => {
    const big = Buffer.from('x'.repeat(DECODED_CAP + 1), 'utf8');
    for (const [encoding, body] of [
      ['gzip', gzipSync(big)],
      ['br', brotliCompressSync(big)],
      ['deflate', deflateSync(big)],
    ] as const) {
      await expect(
        webFetch('https://example.com/', {
          lookup: () => Promise.resolve([PUBLIC_V4]),
          request: () =>
            Promise.resolve(
              streamedResponse({
                headers: { 'content-type': 'text/plain', 'content-encoding': encoding },
                chunks: [body],
              }),
            ),
        }),
      ).rejects.toThrow(/decoded body exceeds/);
    }
  });

  it('rejects corrupted gzip, br, and deflate bodies without inflating them whole first', async () => {
    for (const [encoding, body] of [
      ['gzip', Buffer.from(gzipSync(Buffer.from('ok')).subarray(0, 5))],
      ['br', Buffer.from([0xff, 0xff, 0x00, 0x01])],
      ['deflate', Buffer.from(deflateSync(Buffer.from('ok')).subarray(0, 3))],
    ] as const) {
      await expect(
        webFetch('https://example.com/', {
          lookup: () => Promise.resolve([PUBLIC_V4]),
          request: () =>
            Promise.resolve(
              streamedResponse({
                headers: { 'content-type': 'text/plain', 'content-encoding': encoding },
                chunks: [body],
              }),
            ),
        }),
      ).rejects.toThrow(/failed to decode/);
    }
  });
});

describe('web_fetch timeouts', () => {
  it('aborts and fails a hanging request seam with a bounded timeout', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const pending = webFetch('https://example.com/hang', {
      lookup: () => Promise.resolve([PUBLIC_V4]),
      request: (input) =>
        new Promise<PinnedHttpResponse>((_resolve, reject) => {
          input.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject((input.signal.reason as Error | undefined) ?? new Error('aborted'));
            },
            { once: true },
          );
        }),
    });
    const rejected: Promise<Error> = pending.then(
      () => new Error('expected web_fetch to reject'),
      (error: unknown) => error as Error,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await rejected).message).toMatch(/connect timed out/);
    expect(aborted).toBe(true);
  });
});
