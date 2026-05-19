import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chatAdapter } from './chat.js';

describe('chatAdapter', () => {
  const originalHookCtx = process.env.OPENSQUID_HOOK_CONTEXT;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  let stdoutWrite: ReturnType<typeof vi.fn>;
  let stderrWrite: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stdoutWrite = vi.fn(() => true);
    stderrWrite = vi.fn(() => true);
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (originalHookCtx === undefined) {
      delete process.env.OPENSQUID_HOOK_CONTEXT;
    } else {
      process.env.OPENSQUID_HOOK_CONTEXT = originalHookCtx;
    }
  });

  describe('scheme + validate', () => {
    it('exposes scheme "chat"', () => {
      expect(chatAdapter.scheme).toBe('chat');
    });

    it('validates chat:// and any chat://... suffix; rejects other schemes', () => {
      expect(chatAdapter.validate('chat://')).toBe(true);
      expect(chatAdapter.validate('chat://anything')).toBe(true);
      expect(chatAdapter.validate('chat://main/topic')).toBe(true);
      expect(chatAdapter.validate('telegram://123')).toBe(false);
      expect(chatAdapter.validate('https://example.com')).toBe(false);
      expect(chatAdapter.validate('')).toBe(false);
    });
  });

  describe('send — hook context (OPENSQUID_HOOK_CONTEXT=1)', () => {
    beforeEach(() => {
      process.env.OPENSQUID_HOOK_CONTEXT = '1';
    });

    it('writes tagged line to stderr and returns ok:true', async () => {
      const result = await chatAdapter.send('chat://', { text: 'hello' });

      expect(result).toEqual({ ok: true });
      expect(stderrWrite).toHaveBeenCalledTimes(1);
      expect(stderrWrite).toHaveBeenCalledWith('[opensquid:info] hello\n');
      expect(stdoutWrite).not.toHaveBeenCalled();
    });

    it('tags with explicit severity (error)', async () => {
      await chatAdapter.send('chat://', { text: 'boom', severity: 'error' });
      expect(stderrWrite).toHaveBeenCalledWith('[opensquid:error] boom\n');
      expect(stdoutWrite).not.toHaveBeenCalled();
    });
  });

  describe('send — non-hook context (env var unset)', () => {
    beforeEach(() => {
      delete process.env.OPENSQUID_HOOK_CONTEXT;
    });

    it('writes tagged line to stdout and returns ok:true', async () => {
      const result = await chatAdapter.send('chat://', { text: 'hello' });

      expect(result).toEqual({ ok: true });
      expect(stdoutWrite).toHaveBeenCalledTimes(1);
      expect(stdoutWrite).toHaveBeenCalledWith('[opensquid:info] hello\n');
      expect(stderrWrite).not.toHaveBeenCalled();
    });

    it('sends empty text as a line containing only the tag', async () => {
      const result = await chatAdapter.send('chat://', { text: '' });

      expect(result).toEqual({ ok: true });
      expect(stdoutWrite).toHaveBeenCalledTimes(1);
      expect(stdoutWrite).toHaveBeenCalledWith('[opensquid:info] \n');
    });
  });

  describe('env-var sensitivity', () => {
    it('treats values other than exactly "1" as non-hook context (writes stdout)', async () => {
      process.env.OPENSQUID_HOOK_CONTEXT = 'true';
      await chatAdapter.send('chat://', { text: 'x', severity: 'warning' });
      expect(stdoutWrite).toHaveBeenCalledWith('[opensquid:warning] x\n');
      expect(stderrWrite).not.toHaveBeenCalled();
    });
  });
});
