/**
 * A JSON-RPC stub endpoint on 127.0.0.1, for the genuine network scenarios.
 *
 * `RpcSource`'s failure mapping is about what a socket does — a refused
 * connection, a server that never answers, a body that is not what was asked
 * for — and none of that can be exercised by substituting a fake `fetch`. So the
 * tests run a real HTTP server and a real request against it.
 *
 * 127.0.0.1 is the only host `tests/setup/noNetwork.ts` lets through, and the
 * literal is required: `localhost` is a name that can resolve to `::1` or
 * anywhere `/etc/hosts` says, so the interceptor blocks it deliberately.
 *
 * Not a mock of anything in `src/`. It stands in for a Solana node at the
 * process boundary; every line of `RpcSource` runs for real.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A response to send back. `status` defaults to 200. */
export interface StubReply {
  readonly status?: number;
  readonly body: string;
  readonly contentType?: string;
}

/**
 * What the stub does with a request: answer it, or accept it and never reply.
 * `'hang'` is how the timeout scenario is produced — the connection stays open
 * with no response, which is precisely what a wedged endpoint looks like.
 */
export type StubBehavior = StubReply | 'hang';

export interface StubRpcServer {
  /** Base URL, e.g. `http://127.0.0.1:54321`. */
  readonly url: string;
  /** Parsed request bodies in arrival order; raw text when a body is not JSON. */
  readonly requests: readonly unknown[];
  close(): Promise<void>;
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function startStubRpc(
  respond: (request: unknown) => StubBehavior,
): Promise<StubRpcServer> {
  const requests: unknown[] = [];

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const parsed = parseBody(Buffer.concat(chunks).toString('utf8'));
      requests.push(parsed);

      const behavior = respond(parsed);
      // Deliberately no response and no timer: the request hangs until the
      // client's own AbortSignal fires, or until close() tears the socket down.
      if (behavior === 'hang') return;

      response.writeHead(behavior.status ?? 200, {
        'content-type': behavior.contentType ?? 'application/json',
      });
      response.end(behavior.body);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    requests,
    close: async () => {
      // Hung requests hold sockets open, and server.close() waits for them, so
      // the connections go first or the suite never finishes.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

/**
 * A port nothing is listening on, obtained by binding one and letting it go.
 *
 * Racy in principle — the port could be claimed between the close and the test's
 * request — and the alternative of a hard-coded port is worse, since it can
 * collide with something real. In practice the kernel does not immediately reuse
 * a just-freed ephemeral port.
 */
export async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}
