/**
 * The Requirement 15 read-only guard, and the Requirement 9 determinism guard,
 * as one static check over `src/`.
 *
 * Requirements 15.1–15.6 say the *source* contains no call site that constructs,
 * signs, submits, or simulates a transaction, and none that handles wallet
 * credentials. Requirements 9.3, 9.5, 12.10, and 12.12 say the decode, resolve,
 * analyze, and render path contains no randomness, no clock, no locale, and no
 * float arithmetic on a monetary value. Both are statements about the code
 * itself, not about a particular run, so both are checked by reading the code.
 *
 * ## Why an AST walk rather than a text search
 *
 * `grep sendTransaction src -r` matches design.md, this file's own header, a
 * comment, a string literal, and a variable named `neverSendTransaction`. Every
 * one of those is a false positive, and a check that cries wolf is a check the
 * next maintainer weakens until it is quiet. The TypeScript compiler API — a
 * devDependency already present, so no new dependency — is what makes the
 * difference: it sees `foo.sendTransaction()` in call position and does not see
 * the same nine characters inside a comment or a string. `src/render/decimal.ts`
 * is the concrete case: it contains the words `parseFloat`, `toFixed`, and
 * `toLocaleString` in its module comment, saying it never calls them. A text
 * search fails that file. An AST walk passes it.
 *
 * ## Why call sites rather than imports
 *
 * `@solana/web3.js` is mandated by tech.md and legitimately exports
 * `Transaction`, `sendTransaction`, and `simulateTransaction` from the same
 * module Opsis needs `getTransaction` from. Banning the import would mean banning
 * the dependency. The honest guarantee, and the one Requirement 15 actually
 * states, is that no call site exists — so that is what is asserted, over the
 * whole tree, so a future contributor cannot add one in a new file without the
 * suite failing.
 *
 * ## Exhaustive walk, not sampling
 *
 * This property quantifies over the source files of `src/`, a finite and
 * enumerable set, not over generated values. So it is checked by a deterministic
 * exhaustive walk of every `.ts` file under `src/` rather than with `fast-check`:
 * 100 sampled iterations would be strictly weaker than visiting all of them, and
 * a guard that samples call sites is not a guarantee. `fast-check` is therefore
 * deliberately absent from this file.
 *
 * ## What resolution the walk does, and what it does not
 *
 * For each `CallExpression` and `NewExpression` the walk takes the callee's
 * dotted path and its simple name, then adds two more candidates: the path with
 * its root identifier rewritten through this file's `import` bindings, and the
 * path with its root rewritten through the type checker's alias resolution. So
 * `import { sendAndConfirmTransaction as submit }` followed by `submit(...)` is
 * caught under its real name, and `import * as web3` followed by
 * `web3.Keypair.generate()` matches the `Keypair.generate` entry, because dotted
 * entries match on any segment-aligned suffix.
 *
 * Not caught, stated plainly: a call through a locally rebound variable, as in
 * `const f = conn.sendTransaction; f(tx)`. Resolving that soundly means dataflow
 * analysis, and the indirection is not something a contributor writes by
 * accident — it is something they write to evade this file, which is a code
 * review problem rather than a parser problem.
 *
 * Also not caught: a call whose callee has no name at all, such as
 * `handlers[index]()`. Rather than pass over those in silence, the walk counts
 * them and `ACKNOWLEDGED_UNNAMEABLE_CALLEES` lists the five that exist today with
 * the reason each is safe. A sixth fails the suite.
 *
 * ## The float rule needs types, not syntax
 *
 * `a / b` is float division when the operands are `number` and exact integer
 * division when they are `bigint`, and the two are spelled identically. A purely
 * syntactic rule cannot tell them apart, so this walk builds a real `ts.Program`
 * from the repo's own `tsconfig.json` and asks the type checker for each operand
 * type. `src/render/decimal.ts`'s `magnitude / scale` and `magnitude % scale` are
 * `bigint / bigint`, so they pass; `src/cli.ts`'s `error.timeoutMs / 1000` is
 * `number / number` and would fail, except that `cli.ts` renders a timeout in
 * seconds for a diagnostic message and is not on the monetary path, so it is
 * outside the four directories the float rule covers. That scoping is the rule's
 * one real limitation and it is deliberate: Requirements 12.10 and 12.12 are
 * about lamport and token conversion, which live entirely in
 * `decode/ resolve/ analyze/ render/`.
 *
 * ## Non-vacuity
 *
 * A guard that scans nothing reports a clean scan. So the first assertions are
 * about the scan itself: the file count, the call-expression count, the
 * new-expression count, the presence of named files, coverage of each of the four
 * directories, and — because the float rule is only as good as the type
 * information behind it — that at least one division was judged and that its
 * operands came back as `bigint` rather than `any`. A moved `src/`, a bad glob,
 * or a program whose module resolution silently failed all fail loudly here
 * instead of passing quietly.
 *
 * The last block goes further and proves the matcher bites: it re-runs the same
 * walk over a synthetic probe file overlaid into `src/render/`, containing one
 * violation of each kind, and asserts every one is reported with its file and
 * line — and that the `bigint / bigint` line sitting next to the `number /
 * number` one is not.
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC_ROOT = fileURLToPath(new URL('../../src/', import.meta.url));
const TSCONFIG_PATH = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));

/**
 * The two scopes a rule can carry.
 *
 * `src` is the whole tree: Requirement 15 is about the source, without exception,
 * including `cli.ts` and `source/rpc.ts`.
 *
 * `deterministic` is the decode, resolve, analyze, and render path — the modules
 * that turn one recorded response into one `Analysis` and then into bytes on a
 * terminal. Requirements 9.3, 9.5, 12.10, and 12.12 constrain that path.
 * `bin/opsis.js` is not under `src/` and is out of scope for both; `cli.ts` is in
 * `src` scope but not in `deterministic` scope, which is why its `process.argv`,
 * `process.stdout`, `process.env`, `process.cwd()`, and its
 * seconds-for-a-message division are all untouched by the rules below.
 */
type RuleScope = 'src' | 'deterministic';

/** Path prefixes, relative to `src/`, that make up the `deterministic` scope. */
const DETERMINISTIC_DIRECTORIES: readonly string[] = [
  'analyze/',
  'decode/',
  'render/',
  'resolve/',
];

// ---------------------------------------------------------------------------
// The forbidden set
// ---------------------------------------------------------------------------

/**
 * One forbidden construct.
 *
 * `kind` says what shape of node it matches:
 *
 * - `call-name` — a call whose callee's *simple* name matches, so it catches
 *   `x.sign(...)` for any receiver `x`, and a bare `sign(...)`.
 * - `call-path` — a call whose callee's dotted path ends in this path on a
 *   segment boundary, so `Keypair.generate` matches `web3.Keypair.generate`.
 * - `construct` — a `new` expression whose constructed simple name matches.
 * - `read-path` — a property *read* matching a dotted suffix. Needed because
 *   `process.pid` is named by Requirement 9.5 and design.md's Property 34 but can
 *   never appear in callee position; it is a value, not a function.
 * - `float-division` — `/` or `/=` whose operands are not both `bigint`. It has
 *   no name to match, so it lives here as an entry with its reason rather than as
 *   an unexplained special case elsewhere in the file.
 *
 * `exempt` lists dotted paths that match the rule textually but are not the
 * hazard, each with the reason it is safe stated at the entry.
 */
interface ForbiddenEntry {
  /** Stable label, used in failure messages and in this file's own tests. */
  readonly id: string;
  readonly kind: 'call-name' | 'call-path' | 'construct' | 'read-path' | 'float-division';
  /** The name or dotted path to match. Empty for `float-division`. */
  readonly match: string;
  /** What allowing this call site would cost. Printed on failure. */
  readonly prevents: string;
  readonly scope: RuleScope;
  readonly exempt?: readonly string[];
}

/**
 * Every construct Opsis may not call, in one place, one line per entry.
 *
 * Extending it when a new risky API appears is a one-line change here, which is
 * the point of keeping it as a single constant: there is nowhere else to look and
 * nothing else to wire up.
 */
export const FORBIDDEN_CALL_SITES: readonly ForbiddenEntry[] = [
  // --- Requirement 15.1: transaction construction ------------------------
  {
    id: 'new-Transaction',
    kind: 'construct',
    match: 'Transaction',
    // A legacy transaction object. Constructing one is the first step of every
    // state-modifying flow, and there is no read-only reason to hold one:
    // `getTransaction` returns JSON, which Opsis reads structurally.
    prevents: 'constructing a legacy transaction object (Req 15.1)',
    scope: 'src',
  },
  {
    id: 'new-VersionedTransaction',
    kind: 'construct',
    match: 'VersionedTransaction',
    // The v0 equivalent of the above.
    prevents: 'constructing a versioned transaction object (Req 15.1)',
    scope: 'src',
  },
  {
    id: 'Transaction.from',
    kind: 'call-path',
    match: 'Transaction.from',
    // Deserializing wire bytes into a *mutable* transaction the caller can then
    // sign and send. Reading a recorded response never needs it.
    prevents: 'materializing a signable transaction from bytes (Req 15.1)',
    scope: 'src',
  },
  {
    id: 'VersionedTransaction.deserialize',
    kind: 'call-path',
    match: 'VersionedTransaction.deserialize',
    // As above, for v0.
    prevents: 'materializing a signable versioned transaction from bytes (Req 15.1)',
    scope: 'src',
  },
  {
    id: 'TransactionMessage.compile',
    kind: 'call-name',
    match: 'compileToV0Message',
    // Compiling a message is transaction construction under another name; the
    // result exists only to be signed.
    prevents: 'compiling a transaction message for signing (Req 15.1)',
    scope: 'src',
  },
  {
    id: 'TransactionMessage.compileToLegacyMessage',
    kind: 'call-name',
    match: 'compileToLegacyMessage',
    // The legacy counterpart of `compileToV0Message`.
    prevents: 'compiling a legacy transaction message for signing (Req 15.1)',
    scope: 'src',
  },
  {
    id: 'SystemProgram.transfer',
    kind: 'call-path',
    match: 'SystemProgram.transfer',
    // Opsis *decodes* System transfers (`src/decode/builtin/systemProgram.ts`)
    // and must never build one. Decoding reads bytes; this builds an instruction.
    prevents: 'building a transfer instruction (Req 15.1)',
    scope: 'src',
  },

  // --- Requirement 15.2: signing -----------------------------------------
  {
    id: 'sign',
    kind: 'call-name',
    match: 'sign',
    // The generic entry point: `keypair.sign`, `nacl.sign`, `subtle.sign`,
    // `ed25519.sign`. Any of them means a private key is in the process.
    prevents: 'performing a signing operation with a private key (Req 15.2)',
    scope: 'src',
    // `Math.sign` returns -1, 0, or 1 for a number. It is arithmetic, shares
    // only the four letters, and is the one call this entry would otherwise
    // misread. Listed so the exemption is a decision on the record rather than a
    // loosened rule.
    exempt: ['Math.sign'],
  },
  {
    id: 'signSync',
    kind: 'call-name',
    match: 'signSync',
    // `@noble/ed25519`'s synchronous signer.
    prevents: 'performing a synchronous Ed25519 signing operation (Req 15.2)',
    scope: 'src',
  },
  {
    id: 'signAsync',
    kind: 'call-name',
    match: 'signAsync',
    // The asynchronous form of the same.
    prevents: 'performing an asynchronous Ed25519 signing operation (Req 15.2)',
    scope: 'src',
  },
  {
    id: 'sign_detached',
    kind: 'call-name',
    match: 'sign_detached',
    // TweetNaCl's C-style alias, reachable as `nacl.sign.detached` too — the
    // `detached` entry below covers that spelling.
    prevents: 'producing a detached Ed25519 signature (Req 15.2)',
    scope: 'src',
  },
  {
    id: 'sign.detached',
    kind: 'call-path',
    match: 'sign.detached',
    // `nacl.sign.detached(message, secretKey)`, the usual JavaScript spelling.
    prevents: 'producing a detached Ed25519 signature (Req 15.2)',
    scope: 'src',
  },
  {
    id: 'partialSign',
    kind: 'call-name',
    match: 'partialSign',
    // Signing with a subset of required signers. Still signing.
    prevents: 'partially signing a transaction (Req 15.2)',
    scope: 'src',
  },
  {
    id: 'signTransaction',
    kind: 'call-name',
    match: 'signTransaction',
    // The wallet-adapter entry point. Opsis has no wallet.
    prevents: 'signing a transaction through a wallet (Req 15.2)',
    scope: 'src',
  },
  {
    id: 'signAllTransactions',
    kind: 'call-name',
    match: 'signAllTransactions',
    // The batch form of the above.
    prevents: 'signing transactions in bulk through a wallet (Req 15.2)',
    scope: 'src',
  },
  {
    id: 'signMessage',
    kind: 'call-name',
    match: 'signMessage',
    // Off-chain message signing. No transaction, but the same private key.
    prevents: 'signing an off-chain message with a private key (Req 15.2)',
    scope: 'src',
  },
  {
    id: 'addSignature',
    kind: 'call-name',
    match: 'addSignature',
    // Attaching a signature produced elsewhere: the same authorization, moved
    // one function outward.
    prevents: 'attaching a signature to a transaction (Req 15.2)',
    scope: 'src',
  },
  {
    id: 'createSign',
    kind: 'call-name',
    match: 'createSign',
    // Node's `crypto.createSign`. Note that `createHash` is deliberately absent
    // from this list: `src/decode/idl/idlDecoder.ts` hashes an Anchor
    // discriminator with `createHash('sha256')`, which is a pure function of its
    // input, involves no key, and is exactly what IDL decoding requires.
    prevents: 'constructing a Node signing stream (Req 15.2)',
    scope: 'src',
  },

  // --- Requirement 15.3: submission --------------------------------------
  {
    id: 'sendTransaction',
    kind: 'call-name',
    match: 'sendTransaction',
    // `Connection.sendTransaction`. The single call that would put Opsis on the
    // write path. Note that plain `fetch` is *not* forbidden: `source/rpc.ts`
    // issues one read-only `getTransaction` over it, and forbidding the
    // transport rather than the operation would ban reading too.
    prevents: 'submitting a transaction to the network (Req 15.3)',
    scope: 'src',
  },
  {
    id: 'sendRawTransaction',
    kind: 'call-name',
    match: 'sendRawTransaction',
    // Submission of pre-serialized bytes.
    prevents: 'submitting serialized transaction bytes (Req 15.3)',
    scope: 'src',
  },
  {
    id: 'sendEncodedTransaction',
    kind: 'call-name',
    match: 'sendEncodedTransaction',
    // Submission of a base64 string.
    prevents: 'submitting an encoded transaction (Req 15.3)',
    scope: 'src',
  },
  {
    id: 'sendAndConfirmTransaction',
    kind: 'call-name',
    match: 'sendAndConfirmTransaction',
    // Sign, submit, and wait, in one helper.
    prevents: 'signing, submitting, and confirming a transaction (Req 15.3)',
    scope: 'src',
  },
  {
    id: 'sendAndConfirmRawTransaction',
    kind: 'call-name',
    match: 'sendAndConfirmRawTransaction',
    // The pre-serialized form of the above.
    prevents: 'submitting and confirming serialized transaction bytes (Req 15.3)',
    scope: 'src',
  },
  {
    id: 'confirmTransaction',
    kind: 'call-name',
    match: 'confirmTransaction',
    // Only reachable for a transaction this process just submitted; its presence
    // means a submission happened.
    prevents: 'awaiting confirmation of a submitted transaction (Req 15.3)',
    scope: 'src',
  },
  {
    id: 'requestAirdrop',
    kind: 'call-name',
    match: 'requestAirdrop',
    // A state-modifying RPC that moves funds. Read-only means read-only even on
    // devnet.
    prevents: 'requesting an airdrop, which modifies chain state (Req 15.3)',
    scope: 'src',
  },

  // --- Requirement 15.4: simulation and effect estimation ----------------
  {
    id: 'simulateTransaction',
    kind: 'call-name',
    match: 'simulateTransaction',
    // Simulation asks the chain to predict effects. Opsis explains what already
    // happened; product.md rules simulation out of v1 entirely.
    prevents: 'simulating a transaction (Req 15.4)',
    scope: 'src',
  },
  {
    id: 'simulate',
    kind: 'call-name',
    match: 'simulate',
    // Anchor's `.simulate()` builder terminus.
    prevents: 'simulating a program instruction (Req 15.4)',
    scope: 'src',
  },
  {
    id: 'getFeeForMessage',
    kind: 'call-name',
    match: 'getFeeForMessage',
    // Estimating the fee of a message that was never sent. Opsis reads the
    // recorded `meta.fee` of a transaction that landed instead.
    prevents: 'estimating the fee of an unsent message (Req 15.4)',
    scope: 'src',
  },

  // --- Requirement 15.5: credentials -------------------------------------
  {
    id: 'Keypair.generate',
    kind: 'call-path',
    match: 'Keypair.generate',
    // Generating a keypair creates a private key in this process's memory. It is
    // also nondeterministic, so it fails Requirement 9.3 as well.
    prevents: 'generating a keypair, which creates a private key (Req 15.5, 9.3)',
    scope: 'src',
  },
  {
    id: 'fromSecretKey',
    kind: 'call-name',
    match: 'fromSecretKey',
    // Accepting a secret key. Opsis has no code path that wants one.
    prevents: 'accepting a secret key (Req 15.5)',
    scope: 'src',
  },
  {
    id: 'fromSeed',
    kind: 'call-name',
    match: 'fromSeed',
    // Deriving a keypair from seed bytes.
    prevents: 'deriving a keypair from a seed (Req 15.5)',
    scope: 'src',
  },
  {
    id: 'mnemonicToSeed',
    kind: 'call-name',
    match: 'mnemonicToSeed',
    // BIP39. A mnemonic is a wallet.
    prevents: 'converting a mnemonic phrase to seed bytes (Req 15.5)',
    scope: 'src',
  },
  {
    id: 'mnemonicToSeedSync',
    kind: 'call-name',
    match: 'mnemonicToSeedSync',
    // The synchronous form of the above.
    prevents: 'converting a mnemonic phrase to seed bytes (Req 15.5)',
    scope: 'src',
  },
  {
    id: 'generateMnemonic',
    kind: 'call-name',
    match: 'generateMnemonic',
    // Creating a wallet, which is further than accepting one.
    prevents: 'generating a mnemonic phrase (Req 15.5)',
    scope: 'src',
  },
  {
    id: 'validateMnemonic',
    kind: 'call-name',
    match: 'validateMnemonic',
    // Validating one means one was accepted as input.
    prevents: 'accepting a mnemonic phrase as input (Req 15.5)',
    scope: 'src',
  },
  {
    id: 'createPrivateKey',
    kind: 'call-name',
    match: 'createPrivateKey',
    // Node's keystore/PEM reader.
    prevents: 'loading a private key from a keystore or PEM file (Req 15.5)',
    scope: 'src',
  },
  {
    id: 'generateKeyPair',
    kind: 'call-name',
    match: 'generateKeyPair',
    // Node's asymmetric key generation, and WebCrypto's `subtle.generateKey`
    // sibling below.
    prevents: 'generating an asymmetric key pair (Req 15.5)',
    scope: 'src',
  },
  {
    id: 'generateKeyPairSync',
    kind: 'call-name',
    match: 'generateKeyPairSync',
    // The synchronous form of the above.
    prevents: 'generating an asymmetric key pair (Req 15.5)',
    scope: 'src',
  },
  {
    id: 'generateKey',
    kind: 'call-name',
    match: 'generateKey',
    // `crypto.subtle.generateKey`.
    prevents: 'generating a cryptographic key (Req 15.5)',
    scope: 'src',
  },

  // --- Requirement 9.3: randomness, on the analysis path -----------------
  {
    id: 'Math.random',
    kind: 'call-path',
    match: 'Math.random',
    // The canonical nondeterminism. One call and the same input stops producing
    // the same output, which is the whole promise of product.md.
    prevents: 'drawing a pseudorandom number (Req 9.3)',
    scope: 'deterministic',
  },
  {
    id: 'randomBytes',
    kind: 'call-name',
    match: 'randomBytes',
    // `node:crypto`'s CSPRNG. Again: `createHash` is not on this list, because
    // hashing is a function of its input and randomness is not.
    prevents: 'drawing cryptographically random bytes (Req 9.3)',
    scope: 'deterministic',
  },
  {
    id: 'randomFillSync',
    kind: 'call-name',
    match: 'randomFillSync',
    // The in-place form of the above.
    prevents: 'filling a buffer with random bytes (Req 9.3)',
    scope: 'deterministic',
  },
  {
    id: 'randomFill',
    kind: 'call-name',
    match: 'randomFill',
    // The callback form.
    prevents: 'filling a buffer with random bytes (Req 9.3)',
    scope: 'deterministic',
  },
  {
    id: 'randomInt',
    kind: 'call-name',
    match: 'randomInt',
    // `crypto.randomInt`.
    prevents: 'drawing a random integer (Req 9.3)',
    scope: 'deterministic',
  },
  {
    id: 'randomUUID',
    kind: 'call-name',
    match: 'randomUUID',
    // A fresh identifier per run is a fresh output per run.
    prevents: 'generating a random identifier (Req 9.3)',
    scope: 'deterministic',
  },
  {
    id: 'getRandomValues',
    kind: 'call-name',
    match: 'getRandomValues',
    // WebCrypto's RNG, reachable as `crypto.getRandomValues` and
    // `webcrypto.getRandomValues`.
    prevents: 'drawing random values from WebCrypto (Req 9.3)',
    scope: 'deterministic',
  },

  // --- Requirement 9.5: clocks, durations, process identity --------------
  {
    id: 'Date.now',
    kind: 'call-path',
    match: 'Date.now',
    // A timestamp in the `Analysis` object makes two runs over one fixture
    // differ, which breaks golden comparison as well as Requirement 9.5.
    prevents: 'reading the system clock (Req 9.5)',
    scope: 'deterministic',
  },
  {
    id: 'new-Date',
    kind: 'construct',
    match: 'Date',
    // `new Date()` is the clock; `new Date(x)` additionally formats in the
    // ambient timezone, which Requirement 9.7 forbids. `blockTime` travels
    // through `Analysis` as the integer the chain recorded, never as a `Date`.
    prevents: 'constructing a date, which reads the clock or the timezone (Req 9.5, 9.7)',
    scope: 'deterministic',
  },
  {
    id: 'Date.parse',
    kind: 'call-path',
    match: 'Date.parse',
    // Timezone-dependent for inputs without an offset.
    prevents: 'parsing a date against the ambient timezone (Req 9.7)',
    scope: 'deterministic',
  },
  {
    id: 'hrtime',
    kind: 'call-name',
    match: 'hrtime',
    // Execution duration. The name form, so `process.hrtime()` and a destructured
    // `hrtime()` are both caught.
    prevents: 'measuring execution duration (Req 9.5)',
    scope: 'deterministic',
  },
  {
    id: 'hrtime.bigint',
    kind: 'call-path',
    match: 'hrtime.bigint',
    // `process.hrtime.bigint()` invokes `bigint`, not `hrtime`, so the name rule
    // above does not see it and this path entry is what catches it. A suffix
    // match, so the `process.` prefix is optional.
    prevents: 'measuring execution duration in nanoseconds (Req 9.5)',
    scope: 'deterministic',
  },
  {
    id: 'performance.now',
    kind: 'call-path',
    match: 'performance.now',
    // The other duration clock.
    prevents: 'measuring elapsed time (Req 9.5)',
    scope: 'deterministic',
  },
  {
    id: 'process.uptime',
    kind: 'call-path',
    match: 'process.uptime',
    // A third one.
    prevents: 'reading process uptime (Req 9.5)',
    scope: 'deterministic',
  },
  {
    id: 'process.pid',
    kind: 'read-path',
    match: 'process.pid',
    // Named explicitly by Requirement 9.5. A read rather than a call: nothing
    // calls `process.pid`, so a call-only walk would never see it.
    prevents: 'reading the process id (Req 9.5)',
    scope: 'deterministic',
  },
  {
    id: 'process.ppid',
    kind: 'read-path',
    match: 'process.ppid',
    // The parent process id, same hazard.
    prevents: 'reading the parent process id (Req 9.5)',
    scope: 'deterministic',
  },

  // --- Requirements 9.7, 12.10, 12.12: locale and floating point ---------
  {
    id: 'toLocaleString',
    kind: 'call-name',
    match: 'toLocaleString',
    // Under `de_DE` this turns `1,234.56` into `1.234,56`, so one input yields
    // two byte streams on two machines. `render/decimal.ts` groups thousands
    // with a fixed ASCII comma instead.
    prevents: 'formatting a value against the ambient locale (Req 9.7)',
    scope: 'deterministic',
  },
  {
    id: 'toLocaleDateString',
    kind: 'call-name',
    match: 'toLocaleDateString',
    // Locale and timezone at once.
    prevents: 'formatting a date against the ambient locale (Req 9.7)',
    scope: 'deterministic',
  },
  {
    id: 'toLocaleTimeString',
    kind: 'call-name',
    match: 'toLocaleTimeString',
    // As above.
    prevents: 'formatting a time against the ambient locale (Req 9.7)',
    scope: 'deterministic',
  },
  {
    id: 'toLocaleUpperCase',
    kind: 'call-name',
    match: 'toLocaleUpperCase',
    // Turkish dotless i: `'i'.toLocaleUpperCase('tr')` is `'İ'`. Requirement
    // 12.6 wants uppercase account-role labels, and `toUpperCase` gives the
    // same bytes everywhere.
    prevents: 'uppercasing against the ambient locale (Req 9.7)',
    scope: 'deterministic',
  },
  {
    id: 'toLocaleLowerCase',
    kind: 'call-name',
    match: 'toLocaleLowerCase',
    // The mirror image of the above.
    prevents: 'lowercasing against the ambient locale (Req 9.7)',
    scope: 'deterministic',
  },
  {
    id: 'Intl',
    kind: 'construct',
    match: 'NumberFormat',
    // `new Intl.NumberFormat(...)` is `toLocaleString` with a longer name.
    prevents: 'constructing a locale-aware number formatter (Req 9.7)',
    scope: 'deterministic',
  },
  {
    id: 'Intl.DateTimeFormat',
    kind: 'construct',
    match: 'DateTimeFormat',
    // Locale and timezone again.
    prevents: 'constructing a locale-aware date formatter (Req 9.7)',
    scope: 'deterministic',
  },
  {
    id: 'parseFloat',
    kind: 'call-name',
    match: 'parseFloat',
    // Rounds every lamport value above 2^53 before a digit reaches the output,
    // and the rounded value looks plausible. Covers `Number.parseFloat` too,
    // whose simple name is the same.
    prevents: 'parsing a monetary value into a float (Req 12.10, 12.12)',
    scope: 'deterministic',
  },
  {
    id: 'toFixed',
    kind: 'call-name',
    match: 'toFixed',
    // Float formatting with a fixed digit count — the plausible-looking wrong
    // answer for lamports. `formatFixedPoint` does it with `bigint` and
    // `padStart`.
    prevents: 'formatting a monetary value through binary floating point (Req 12.10, 12.12)',
    scope: 'deterministic',
  },
  {
    id: 'toPrecision',
    kind: 'call-name',
    match: 'toPrecision',
    // Same hazard, different spelling.
    prevents: 'formatting a monetary value through binary floating point (Req 12.10, 12.12)',
    scope: 'deterministic',
  },
  {
    id: 'toExponential',
    kind: 'call-name',
    match: 'toExponential',
    // `1e9` is not a digit string a reader can copy.
    prevents: 'formatting a monetary value in exponential notation (Req 12.10, 12.12)',
    scope: 'deterministic',
  },
  {
    id: 'float-division',
    kind: 'float-division',
    match: '',
    // The one rule with no name to grep for: `/` and `/=` where the operands are
    // not both `bigint`. `render/decimal.ts` divides `bigint` by `bigint`, which
    // is exact at every magnitude; the same two characters between two `number`s
    // silently truncates a u64 lamport value. Only the type checker can tell the
    // two apart, which is why this walk builds a real program.
    prevents: 'dividing a monetary value in binary floating point (Req 12.10, 12.12)',
    scope: 'deterministic',
  },
];

/**
 * The call sites whose callee this walk cannot name, read by hand and accounted
 * for one by one.
 *
 * Every other call site in `src/` has a name the rules above can judge. These do
 * not, so listing them is the only honest alternative to letting them pass
 * silently: the assertion in `the scan itself` requires the unnameable set to be
 * exactly this, so a sixth one anywhere in the tree fails the suite and lands on
 * whoever added it.
 */
export const ACKNOWLEDGED_UNNAMEABLE_CALLEES: readonly {
  readonly file: string;
  readonly kind: string;
  readonly count: number;
  readonly reason: string;
}[] = [
  {
    file: 'render/text.ts',
    kind: 'ElementAccessExpression',
    count: 4,
    // `createPalette` builds the four painters Requirement 12.4 fixes by indexing
    // the `picocolors` color set with a key from `CATEGORY_COLORS`. The receiver
    // is the object `pc.createColors(true)` returned, the key is a literal from a
    // frozen table in the same module, and every value in that object is a
    // `string => string` formatter. There is no reachable member of it that
    // constructs, signs, sends, or reads a clock.
    reason: 'picocolors palette lookup by category key, all values are string formatters',
  },
  {
    file: 'render/json.ts',
    kind: 'SuperKeyword',
    count: 1,
    // `JsonSerializationError extends Error`; the call is `super(message)`.
    reason: 'Error subclass constructor chaining',
  },
];

// ---------------------------------------------------------------------------
// Reading the tree
// ---------------------------------------------------------------------------

/** Every `.ts` file under `src/`, sorted, so the walk order is deterministic. */
function sourceFiles(root: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found.sort();
}

/** Path relative to `src/`, forward slashes, for readable failure messages. */
function label(path: string): string {
  return relative(SRC_ROOT, path).split('\\').join('/');
}

/**
 * The repo's own compiler options, read from `tsconfig.json` rather than
 * restated here, so the guard cannot type-check the source under different rules
 * than `npm run typecheck` does.
 */
function compilerOptions(): ts.CompilerOptions {
  const read = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile);
  if (read.error !== undefined) {
    throw new Error(
      `could not read ${TSCONFIG_PATH}: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, REPO_ROOT);
  if (parsed.errors.length > 0) {
    throw new Error(
      `could not parse ${TSCONFIG_PATH}: ${parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, ' '))
        .join('; ')}`,
    );
  }
  return { ...parsed.options, noEmit: true, skipLibCheck: true };
}

// ---------------------------------------------------------------------------
// Naming a callee
// ---------------------------------------------------------------------------

/** The dotted path of an expression, or null when a segment is computed. */
function dottedPath(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return 'this';

  if (ts.isPropertyAccessExpression(expression)) {
    const base = dottedPath(expression.expression);
    return base === null ? null : `${base}.${expression.name.text}`;
  }

  // `a['sendTransaction']()` is the same call as `a.sendTransaction()`.
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    if (!ts.isStringLiteralLike(argument)) return null;
    const base = dottedPath(expression.expression);
    return base === null ? null : `${base}.${argument.text}`;
  }

  if (ts.isParenthesizedExpression(expression)) return dottedPath(expression.expression);
  if (ts.isNonNullExpression(expression)) return dottedPath(expression.expression);

  return null;
}

/** The last segment of a dotted path: the name actually being invoked. */
function simpleName(path: string): string {
  const segments = path.split('.');
  return segments[segments.length - 1] ?? path;
}

/** `import { a as b }` bindings for one file, as local name to original name. */
function importAliases(file: ts.SourceFile): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();

  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;

    for (const element of bindings.elements) {
      if (element.propertyName !== undefined) {
        aliases.set(element.name.text, element.propertyName.text);
      }
    }
  }

  return aliases;
}

/**
 * The name being invoked, independent of whether the receiver has a name.
 *
 * This is why `call-name` and `call-path` are separate kinds. `[...nodes].sort()`
 * and `createHash('sha256').update(...)` have no dotted path at all — their
 * receiver is an array literal and a call — but they very much have a method
 * name, and so would `loadKeypair().sign(message)`. Sixty-two of the current
 * tree's call sites are of that shape. A path-only matcher would not see any of
 * them, which for a signing rule is the difference between a guard and a
 * decoration.
 */
function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    return ts.isStringLiteralLike(argument) ? argument.text : null;
  }
  if (ts.isParenthesizedExpression(expression)) return calleeName(expression.expression);
  if (ts.isNonNullExpression(expression)) return calleeName(expression.expression);
  return null;
}

/**
 * Every spelling of one callee that a rule may match against.
 *
 * `paths` holds the dotted path as written plus the same path with its root
 * rewritten through this file's `import` bindings and through the checker's alias
 * resolution, so `import { Keypair as KP }` followed by `KP.generate()` is
 * matched under `Keypair.generate`. It is empty when a segment is computed.
 *
 * `names` holds the invoked simple name, including the names those rewrites
 * produce, so `import { sendAndConfirmTransaction as submit }` followed by
 * `submit(...)` is matched under its real name.
 */
interface Callee {
  readonly names: readonly string[];
  readonly paths: readonly string[];
}

function calleeSpellings(
  expression: ts.Expression,
  aliases: ReadonlyMap<string, string>,
  checker: ts.TypeChecker,
): Callee {
  const paths = new Set<string>();
  const names = new Set<string>();

  const bare = calleeName(expression);
  if (bare !== null) names.add(bare);

  const path = dottedPath(expression);
  if (path !== null) {
    paths.add(path);

    const segments = path.split('.');
    const root = segments[0];
    const rest = segments.slice(1);

    const rewrite = (name: string): void => {
      paths.add([name, ...rest].join('.'));
    };

    if (root !== undefined) {
      const alias = aliases.get(root);
      if (alias !== undefined) rewrite(alias);

      // Catches re-export chains and `export { x as y }` indirection the
      // syntactic map above cannot see.
      let rootNode: ts.Node = expression;
      while (ts.isPropertyAccessExpression(rootNode) || ts.isElementAccessExpression(rootNode)) {
        rootNode = rootNode.expression;
      }
      if (ts.isIdentifier(rootNode)) {
        const symbol = checker.getSymbolAtLocation(rootNode);
        if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
          rewrite(checker.getAliasedSymbol(symbol).getName());
        }
      }
    }

    for (const candidate of paths) names.add(simpleName(candidate));
  }

  return { names: [...names], paths: [...paths] };
}

/** Does `path` end in `suffix` on a segment boundary? */
function endsInSegment(path: string, suffix: string): boolean {
  return path === suffix || path.endsWith(`.${suffix}`);
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
  readonly prevents: string;
  /** The offending source text, one line, truncated. */
  readonly code: string;
}

interface DivisionSite {
  readonly file: string;
  readonly line: number;
  readonly left: string;
  readonly right: string;
  readonly bothBigInt: boolean;
}

interface CallSite {
  readonly file: string;
  readonly line: number;
  /** The dotted path, or the bare name when the receiver has no path. */
  readonly path: string;
  readonly name: string;
}

/** A call whose callee the walk could not name at all. See the test on these. */
interface UnnamedCallee {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly code: string;
}

interface Scan {
  readonly files: readonly string[];
  readonly callExpressions: number;
  readonly newExpressions: number;
  readonly callSites: readonly CallSite[];
  readonly unnamedCallees: readonly UnnamedCallee[];
  readonly divisions: readonly DivisionSite[];
  readonly violations: readonly Violation[];
}

function inDeterministicScope(file: string): boolean {
  return DETERMINISTIC_DIRECTORIES.some((directory) => file.startsWith(directory));
}

function appliesTo(entry: ForbiddenEntry, file: string): boolean {
  return entry.scope === 'src' || inDeterministicScope(file);
}

/** All constituents of a possibly-union type satisfy `predicate`. */
function everyConstituent(type: ts.Type, predicate: (part: ts.Type) => boolean): boolean {
  if (type.isUnionOrIntersection()) {
    return type.types.every((part) => everyConstituent(part, predicate));
  }
  return predicate(type);
}

function isBigIntLike(type: ts.Type): boolean {
  return everyConstituent(type, (part) => (part.flags & ts.TypeFlags.BigIntLike) !== 0);
}

const MAX_CODE_LENGTH = 90;

/**
 * Walk every file under `src/` and collect the counts, the call sites, the
 * divisions, and the violations.
 *
 * `overlay` replaces or adds file contents in memory. The real scan passes none;
 * the probe block at the bottom uses it to prove the matcher fires.
 */
function scanSource(overlay?: ReadonlyMap<string, string>): Scan {
  const onDisk = sourceFiles(SRC_ROOT);
  const rootNames = overlay === undefined ? onDisk : [...onDisk, ...overlay.keys()].sort();
  const options = compilerOptions();

  let host = ts.createCompilerHost(options, true);
  if (overlay !== undefined) {
    const base = host;
    const overlaid = (fileName: string): string | undefined =>
      overlay.get(fileName.split('\\').join('/'));

    host = {
      ...base,
      getSourceFile: (fileName, languageVersion, onError, shouldCreate) => {
        const text = overlaid(fileName);
        if (text === undefined) {
          return base.getSourceFile(fileName, languageVersion, onError, shouldCreate);
        }
        return ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS);
      },
      fileExists: (fileName) => overlaid(fileName) !== undefined || base.fileExists(fileName),
      readFile: (fileName) => overlaid(fileName) ?? base.readFile(fileName),
    };
  }

  const program = ts.createProgram(rootNames, options, host);
  const checker = program.getTypeChecker();

  const files: string[] = [];
  const callSites: CallSite[] = [];
  const unnamedCallees: UnnamedCallee[] = [];
  const divisions: DivisionSite[] = [];
  const violations: Violation[] = [];
  let callExpressions = 0;
  let newExpressions = 0;

  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile) continue;
    const relativePath = label(file.fileName);
    // Anything outside `src/` — a lib file, a resolved dependency — is not ours.
    if (relativePath.startsWith('..')) continue;

    files.push(relativePath);
    const aliases = importAliases(file);
    const deterministic = inDeterministicScope(relativePath);

    const lineOf = (node: ts.Node): number =>
      file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

    const codeOf = (node: ts.Node): string => {
      const text = node.getText(file).split('\n')[0] ?? '';
      return text.length > MAX_CODE_LENGTH ? `${text.slice(0, MAX_CODE_LENGTH)}...` : text;
    };

    const report = (node: ts.Node, entry: ForbiddenEntry): void => {
      violations.push({
        file: relativePath,
        line: lineOf(node),
        ruleId: entry.id,
        prevents: entry.prevents,
        code: codeOf(node),
      });
    };

    /**
     * Match one callee against the entries of the given kinds.
     *
     * Name entries are matched against `callee.names` and path entries against
     * `callee.paths`, so a rule aimed at a method name still fires on a receiver
     * the walk cannot name. Exemptions are matched against paths, because an
     * exemption has to be specific — `Math.sign` is safe, a bare `sign` is not.
     */
    const check = (
      node: ts.Node,
      callee: Callee,
      kinds: readonly ForbiddenEntry['kind'][],
    ): void => {
      for (const entry of FORBIDDEN_CALL_SITES) {
        if (!kinds.includes(entry.kind)) continue;
        if (!appliesTo(entry, relativePath)) continue;

        const exempt = entry.exempt ?? [];
        if (callee.paths.some((path) => exempt.some((safe) => endsInSegment(path, safe)))) continue;

        const hit =
          entry.kind === 'call-name' || entry.kind === 'construct'
            ? callee.names.includes(entry.match)
            : callee.paths.some((path) => endsInSegment(path, entry.match));
        if (hit) report(node, entry);
      }
    };

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        callExpressions += 1;
        const callee = calleeSpellings(node.expression, aliases, checker);
        const name = callee.names[0];
        if (name === undefined) {
          unnamedCallees.push({
            file: relativePath,
            line: lineOf(node),
            kind: ts.SyntaxKind[node.expression.kind] ?? String(node.expression.kind),
            code: codeOf(node),
          });
        } else {
          callSites.push({
            file: relativePath,
            line: lineOf(node),
            path: callee.paths[0] ?? name,
            name,
          });
        }
        check(node, callee, ['call-name', 'call-path']);
      } else if (ts.isNewExpression(node)) {
        newExpressions += 1;
        check(node, calleeSpellings(node.expression, aliases, checker), ['construct', 'call-path']);
      } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const path = dottedPath(node);
        if (path !== null) check(node, { names: [], paths: [path] }, ['read-path']);
      }

      if (
        deterministic &&
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.SlashToken ||
          node.operatorToken.kind === ts.SyntaxKind.SlashEqualsToken)
      ) {
        // Base types rather than literal types, so the report reads
        // `number / number` instead of `1000000000 / 1000000000`. `bigint`
        // literals widen to `bigint`, so the distinction the rule turns on is
        // unaffected.
        const left = checker.getBaseTypeOfLiteralType(checker.getTypeAtLocation(node.left));
        const right = checker.getBaseTypeOfLiteralType(checker.getTypeAtLocation(node.right));
        const bothBigInt = isBigIntLike(left) && isBigIntLike(right);

        divisions.push({
          file: relativePath,
          line: lineOf(node),
          left: checker.typeToString(left),
          right: checker.typeToString(right),
          bothBigInt,
        });

        if (!bothBigInt) {
          const entry = FORBIDDEN_CALL_SITES.find((candidate) => candidate.id === 'float-division');
          if (entry === undefined) throw new Error('the float-division entry is missing');
          violations.push({
            file: relativePath,
            line: lineOf(node),
            ruleId: entry.id,
            prevents: entry.prevents,
            code: `${codeOf(node)}  [${checker.typeToString(left)} / ${checker.typeToString(right)}]`,
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(file, visit);
  }

  return {
    files: files.sort(),
    callExpressions,
    newExpressions,
    callSites,
    unnamedCallees,
    divisions,
    violations,
  };
}

/** One violation per line, so a failure names the file, the line, and the call. */
function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map(
      (violation) =>
        `src/${violation.file}:${violation.line}  ${violation.ruleId} — ${violation.prevents}\n    ${violation.code}`,
    )
    .join('\n');
}

const scan = scanSource();

// ---------------------------------------------------------------------------
// Property 34
// ---------------------------------------------------------------------------

// Feature: solana-transaction-analyzer, Property 34: No forbidden call site
// exists anywhere in the source
//
// **Validates: Requirements 9.3, 9.5, 12.10, 12.12, 15.1, 15.2, 15.3, 15.4,
// 15.5, 15.6**

/**
 * Thresholds for the non-vacuity block. Well below the current tree — 36 files,
 * 1048 calls, 55 `new` expressions — so ordinary refactoring does not trip them,
 * and far above zero, so a scan that found nothing cannot pass.
 */
const MIN_FILES = 25;
const MIN_CALL_EXPRESSIONS = 200;
const MIN_NEW_EXPRESSIONS = 10;

describe('the scan itself', () => {
  it('found the source tree it is asserting about', () => {
    // Without this, a moved `src/`, a renamed directory, or a compiler host that
    // silently returned nothing would report a clean scan of an empty set.
    expect(scan.files.length).toBeGreaterThanOrEqual(MIN_FILES);
    expect(scan.callExpressions).toBeGreaterThanOrEqual(MIN_CALL_EXPRESSIONS);
    expect(scan.newExpressions).toBeGreaterThanOrEqual(MIN_NEW_EXPRESSIONS);
    expect(scan.callSites.length + scan.unnamedCallees.length).toBe(scan.callExpressions);
  });

  it('could name the callee of every call site but the five acknowledged ones', () => {
    // The coverage assertion, and the honest half of the guarantee. A call whose
    // callee has no name — `handlers[i]()`, `(cond ? f : g)()` — is a call no
    // name rule can judge. Rather than report a clean scan over a tree with
    // unexamined holes in it, the walk counts them and this asserts the set is
    // exactly the five in `ACKNOWLEDGED_UNNAMEABLE_CALLEES`, each read by hand.
    // A sixth appearing anywhere fails here.
    const unexplained = scan.unnamedCallees.filter(
      (site) =>
        !ACKNOWLEDGED_UNNAMEABLE_CALLEES.some(
          (allowed) => allowed.file === site.file && allowed.kind === site.kind,
        ),
    );

    expect(
      unexplained.map((site) => `src/${site.file}:${site.line}  ${site.kind}  ${site.code}`),
    ).toEqual([]);

    for (const allowed of ACKNOWLEDGED_UNNAMEABLE_CALLEES) {
      const matching = scan.unnamedCallees.filter(
        (site) => site.file === allowed.file && site.kind === allowed.kind,
      );
      expect(matching).toHaveLength(allowed.count);
    }
  });

  it('parsed the entry point and the modules the rules are aimed at', () => {
    expect(scan.files).toContain('cli.ts');
    expect(scan.files).toContain('pipeline.ts');
    expect(scan.files).toContain('render/decimal.ts');
    expect(scan.files).toContain('render/text.ts');
    expect(scan.files).toContain('decode/idl/idlDecoder.ts');
    expect(scan.files).toContain('source/rpc.ts');
  });

  it.each(DETERMINISTIC_DIRECTORIES)('walked call sites inside %s', (directory: string) => {
    // Per directory rather than in aggregate, so one of the four disappearing
    // from the walk fails by name instead of hiding behind the other three.
    expect(scan.files.filter((file) => file.startsWith(directory)).length).toBeGreaterThan(0);
    expect(scan.callSites.filter((site) => site.file.startsWith(directory)).length).toBeGreaterThan(
      0,
    );
  });

  it('resolved real operand types for the divisions it judged', () => {
    // The float rule is only as good as the type information behind it. If
    // module resolution failed, every operand would come back `any` and the rule
    // would still report zero violations. `render/decimal.ts` is the anchor:
    // exactly one `/`, both operands `bigint`.
    expect(scan.divisions.length).toBeGreaterThan(0);
    expect(scan.divisions.map((division) => division.file)).toContain('render/decimal.ts');

    const anchor = scan.divisions.find((division) => division.file === 'render/decimal.ts');
    if (anchor === undefined) {
      throw new Error(
        'render/decimal.ts no longer contains a division; move this anchor to whichever module now performs the bigint split, or the float rule is unverified',
      );
    }
    expect(anchor.left).toBe('bigint');
    expect(anchor.right).toBe('bigint');
  });
});

describe('the forbidden set', () => {
  it('is not empty and covers both scopes', () => {
    expect(FORBIDDEN_CALL_SITES.length).toBeGreaterThan(20);
    expect(FORBIDDEN_CALL_SITES.some((entry) => entry.scope === 'src')).toBe(true);
    expect(FORBIDDEN_CALL_SITES.some((entry) => entry.scope === 'deterministic')).toBe(true);
  });

  it('gives every entry a unique id and a stated reason', () => {
    // The id and the reason are what a failure prints; a duplicate id would make
    // two different hazards indistinguishable in the report.
    const ids = FORBIDDEN_CALL_SITES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of FORBIDDEN_CALL_SITES) {
      expect(entry.prevents.length).toBeGreaterThan(0);
      if (entry.kind !== 'float-division') expect(entry.match.length).toBeGreaterThan(0);
    }
  });
});

describe('Property 34: no forbidden call site exists anywhere in the source', () => {
  it('constructs, signs, submits, or simulates nothing anywhere under src/', () => {
    // Requirements 15.1–15.4, 15.6, and 15.5's credential handling. Whole tree,
    // no exceptions: `cli.ts` and `source/rpc.ts` are in scope too.
    const readOnly = new Set(
      FORBIDDEN_CALL_SITES.filter((entry) => entry.scope === 'src').map((entry) => entry.id),
    );
    const found = scan.violations.filter((violation) => readOnly.has(violation.ruleId));

    expect(formatViolations(found)).toBe('');
    expect(found).toEqual([]);
  });

  it('draws no randomness, reads no clock, and uses no locale or float on the analysis path', () => {
    // Requirements 9.3, 9.5, 9.7, 12.10, 12.12 over decode/, resolve/,
    // analyze/, render/.
    const deterministic = new Set(
      FORBIDDEN_CALL_SITES.filter((entry) => entry.scope === 'deterministic').map(
        (entry) => entry.id,
      ),
    );
    const found = scan.violations.filter((violation) => deterministic.has(violation.ruleId));

    expect(formatViolations(found)).toBe('');
    expect(found).toEqual([]);
  });

  it('reports no violation of any kind, so no rule is left unaccounted for', () => {
    // The two assertions above partition the set by scope; this one catches an
    // entry added with a scope neither of them names.
    expect(formatViolations(scan.violations)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Call sites that are deliberately allowed
// ---------------------------------------------------------------------------

describe('the guard permits what the design permits', () => {
  it('allows the SHA-256 hash that produces an Anchor discriminator', () => {
    // `createHash` is a pure function of its input and takes no key, so it is
    // neither a signing operation nor a random source. Asserted as present, not
    // merely unflagged, so a rule added later that bans it fails here with the
    // reason written down rather than in a code review.
    const hashes = scan.callSites.filter(
      (site) => site.name === 'createHash' && site.file === 'decode/idl/idlDecoder.ts',
    );

    expect(hashes.length).toBeGreaterThan(0);
    expect(scan.violations.filter((violation) => violation.code.includes('createHash'))).toEqual([]);
  });

  it('allows Number.isSafeInteger and Number.isInteger as predicates', () => {
    // They read a value and return a boolean. No numeric value flows through
    // them, so they are not float conversions.
    const predicates = scan.callSites.filter(
      (site) => site.name === 'isSafeInteger' || site.name === 'isInteger',
    );

    expect(predicates.length).toBeGreaterThan(0);
    expect(scan.violations.map((violation) => violation.ruleId)).not.toContain('parseFloat');
  });

  it('allows the one read-only RPC call and the fetch that carries it', () => {
    // Requirement 15.3 forbids submitting a transaction, not reading one.
    // Banning the transport would ban `getTransaction` with it.
    const fetches = scan.callSites.filter((site) => site.path === 'globalThis.fetch');

    expect(fetches.map((site) => site.file)).toContain('source/rpc.ts');
    expect(scan.violations.filter((violation) => violation.file === 'source/rpc.ts')).toEqual([]);
  });

  it('leaves cli.ts outside the determinism rules', () => {
    // `cli.ts` divides a millisecond timeout by 1000 to say "10 seconds" in a
    // diagnostic message. That is a `number / number`, and it is fine: it is not
    // a monetary value and `cli.ts` is not on the `Analysis` path. Pinned so the
    // scoping decision is visible rather than accidental.
    expect(scan.divisions.filter((division) => division.file === 'cli.ts')).toEqual([]);
    expect(scan.violations.filter((violation) => violation.file === 'cli.ts')).toEqual([]);

    const processReads = scan.callSites.filter((site) => site.path.startsWith('process.'));
    expect(processReads.map((site) => site.file)).toContain('cli.ts');
  });
});

// ---------------------------------------------------------------------------
// The guard bites
// ---------------------------------------------------------------------------

/**
 * A synthetic module overlaid at `src/render/__forbidden_probe__.ts` — inside
 * both scopes — containing one violation of each kind plus two lines that must
 * *not* be flagged.
 *
 * It never touches the disk. The point is that the rules above are executable
 * and fire, permanently, rather than having been observed to fire once by
 * whoever wrote them.
 */
const PROBE_PATH = `${SRC_ROOT.split('\\').join('/')}render/__forbidden_probe__.ts`;

const PROBE_SOURCE = `
import { Keypair as KP, Transaction as Tx } from '@solana/web3.js';

function signer(): { sign: (message: string) => string } {
  return { sign: (message: string) => message };
}

export function probe(a: number, b: number, c: bigint, d: bigint): unknown {
  const built = new Tx();
  const signed = signer().sign('message');
  const generated = KP.generate();
  const drawn = Math.random();
  const stamped = Date.now();
  const dated = new Date();
  const rounded = a.toFixed(2);
  const parsed = parseFloat('1.5');
  const localized = b.toLocaleString();
  const ticks = process.hrtime.bigint();
  const pid = process.pid;
  const floatQuotient = a / b;
  const exactQuotient = c / d;
  const signum = Math.sign(a);
  const safe = Number.isSafeInteger(a);
  return [built, signed, generated, drawn, stamped, dated, rounded, parsed, localized, ticks, pid,
    floatQuotient, exactQuotient, signum, safe];
}
`;

const probeScan = scanSource(new Map([[PROBE_PATH, PROBE_SOURCE]]));
const probeViolations = probeScan.violations.filter(
  (violation) => violation.file === 'render/__forbidden_probe__.ts',
);

describe('the guard detects what it forbids', () => {
  it('parsed the probe as part of the tree', () => {
    expect(probeScan.files).toContain('render/__forbidden_probe__.ts');
    // The real tree is still there alongside it, so the probe is being judged by
    // the same walk under the same options.
    expect(probeScan.files.length).toBe(scan.files.length + 1);
  });

  it.each([
    'new-Transaction',
    // `signer().sign(...)`: a chained receiver with no dotted path, caught by the
    // name rule. This is the sixty-two-call-site shape the header describes.
    'sign',
    'Keypair.generate',
    'Math.random',
    'Date.now',
    'new-Date',
    'toFixed',
    'parseFloat',
    'toLocaleString',
    'hrtime.bigint',
    'process.pid',
    'float-division',
  ])('reports %s in the probe', (ruleId: string) => {
    expect(probeViolations.map((violation) => violation.ruleId)).toContain(ruleId);
  });

  it('names the file and the offending expression in the report', () => {
    // A guard that fails without saying where is a guard nobody can act on.
    const rendered = formatViolations(probeViolations);

    expect(rendered).toContain('src/render/__forbidden_probe__.ts:');
    expect(rendered).toContain('new Tx()');
    expect(rendered).toContain('a / b');
    expect(rendered).toContain('constructing a legacy transaction object');
  });

  it('does not flag the bigint division sitting next to the float one', () => {
    // The whole reason this walk carries a type checker: `c / d` and `a / b` are
    // the same three tokens.
    const rendered = formatViolations(probeViolations);

    expect(rendered).not.toContain('c / d');
    expect(probeScan.divisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'render/__forbidden_probe__.ts',
          left: 'bigint',
          right: 'bigint',
          bothBigInt: true,
        }),
      ]),
    );
  });

  it('does not flag Math.sign or Number.isSafeInteger', () => {
    // The two exemptions, exercised rather than asserted in a comment.
    const rendered = formatViolations(probeViolations);

    expect(rendered).not.toContain('Math.sign');
    expect(rendered).not.toContain('isSafeInteger');
  });

  it('leaves the real tree unaffected by the overlay', () => {
    // The overlaid scan must report exactly the probe's violations and nothing
    // else, or the probe would be masking a finding in a real file.
    expect(probeScan.violations.length).toBe(probeViolations.length);
    expect(probeViolations.length).toBeGreaterThan(0);
  });
});
