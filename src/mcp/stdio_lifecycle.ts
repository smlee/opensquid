interface LifetimeProcess {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  exit(code: number): never;
  stderr: { write(text: string): unknown };
}

interface StdioLifetimeDeps {
  readonly closeServer: () => Promise<void>;
  readonly cleanup?: () => void | Promise<void>;
  readonly stdin?: NodeJS.ReadableStream;
  readonly processRef?: LifetimeProcess;
}

/**
 * Bind an MCP stdio server's lifetime to its parent pipe. The SDK transport listens for data/error but not EOF;
 * a server with sockets or reconnect timers would otherwise survive its Pi parent and become a PID-1 orphan.
 */
export function bindStdioLifetime(deps: StdioLifetimeDeps): { close: () => Promise<void> } {
  const stdin = deps.stdin ?? process.stdin;
  const processRef = deps.processRef ?? process;
  let closing: Promise<void> | null = null;

  const detach = (): void => {
    stdin.removeListener('end', onEof);
    stdin.removeListener('close', onEof);
    processRef.removeListener('SIGINT', onSigint);
    processRef.removeListener('SIGTERM', onSigterm);
  };
  const close = (): Promise<void> => {
    if (closing !== null) return closing;
    closing = (async () => {
      detach();
      await deps.cleanup?.();
      await deps.closeServer();
    })();
    return closing;
  };
  const onEof = (): void => {
    void close().catch((error: unknown) => {
      processRef.stderr.write(`opensquid MCP EOF cleanup failed: ${String(error)}\n`);
    });
  };
  const signal = (code: number): void => {
    void close()
      .catch((error: unknown) => {
        processRef.stderr.write(`opensquid MCP signal cleanup failed: ${String(error)}\n`);
      })
      .finally(() => processRef.exit(code));
  };
  const onSigint = (): void => signal(130);
  const onSigterm = (): void => signal(143);

  stdin.once('end', onEof);
  stdin.once('close', onEof);
  processRef.once('SIGINT', onSigint);
  processRef.once('SIGTERM', onSigterm);
  return { close };
}
