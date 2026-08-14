---
inclusion: always
---

# Technology stack

Node.js 20+, TypeScript 5.x, ES modules, strict mode.
Distributed on npm, runnable as `npx opsis <signature>` with no install step.

TypeScript over Rust is deliberate and not open for revision. `npx` gives a
reviewer a working tool in one command with no toolchain. A `cargo install` that
compiles for four minutes fails the two-minute constraint in product.md. Do not
propose Rust.

## Dependencies

Keep the list short enough to read in one screen. Every addition needs a reason
recorded in design.md.

- `@solana/web3.js` — RPC client, transaction and message types
- `bs58` — base58 encode/decode
- `commander` — argument parsing
- `picocolors` — terminal color, tiny, no dependency tree
- `vitest` — test runner with golden-file support

Verify current major versions at install time rather than assuming.

## Architecture rule

Decode into a normalized `Analysis` object, then render. The text renderer and
the JSON renderer both consume that same object. Golden tests assert against the
object, never against terminal output, so color codes cannot break tests.

## Testing

Every fixture directory in `fixtures/` is one test case: `input.json` is a
verbatim recorded RPC response, `expected.json` is the exact output. Tests run
the full pipeline end to end and compare. No mocking of internal modules.

The test suite must pass with the network disconnected.
