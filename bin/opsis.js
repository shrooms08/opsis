#!/usr/bin/env node
/**
 * The shim. The only place in Opsis that terminates the process.
 *
 * Everything it does is here: hand `main` the real argv and the real process
 * context, wait for stdout and stderr to reach the operating system, and exit
 * with the code `main` returned. No argument parsing, no error formatting, no
 * fallback behaviour — all of that is `src/cli.ts`, which is where it can be
 * tested.
 *
 * `argv` and the context come from `processArgv()` and `processContext()` rather
 * than being assembled here, so `cli.ts` keeps the only references to
 * `process.argv`, `process.stdout`, `process.stderr`, `process.env`, and the
 * working directory, exactly as design.md says it does. `process.exit` is the one
 * `process` call this file makes.
 *
 * **Why the flush.** `process.exit` terminates without waiting for queued writes,
 * and writes to a pipe are asynchronous — so `opsis SIG --json | jq` could lose
 * the tail of a large analysis if the exit raced the write. Draining both streams
 * first makes the output complete whether stdout is a terminal, a file, or a pipe.
 *
 * Imports from `../dist/` because that is what npm ships (`files` lists `bin/`
 * and `dist/`) and `prepare` runs the build, so `dist/cli.js` exists after any
 * install, including `npx opsis`.
 */
import { main, processArgv, processContext } from '../dist/cli.js';

/** Resolves once everything already written to `stream` has been handed off. */
function flushed(stream) {
  return new Promise((resolve) => {
    if (stream.writableLength === 0) {
      resolve();
      return;
    }
    // An empty chunk whose callback fires after the queued ones have.
    stream.write('', () => resolve());
  });
}

const code = await main(processArgv(), processContext());

await flushed(process.stdout);
await flushed(process.stderr);

process.exit(code);
