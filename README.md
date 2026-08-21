# Opsis

**A read-only CLI that explains what a transaction did, and why it failed.**

When a Solana transaction fails, the developer gets back this:

```
Error processing Instruction 3: custom program error: 0x1771
```

No program named. No instruction named. No cause. Resolving it by hand means
finding which program owns instruction 3, converting hex to decimal, working out
which error namespace applies, and reading an interface definition file. Every
Solana developer does this repeatedly, and it takes minutes each time.

Opsis does it in one command.

The name is Greek *opsis*, "sight" — the root inside *autopsy*, which means
"to see with one's own eyes," not "to cut open a corpse." Opsis does not guess
or infer. It shows what is already there.

```
opsis 4MqxZnZ3VXjTK1zARqA5Z6k4MupZkHESTM7kJX3itwc7NLWWZAbdpeKiwcYrRRPPtT4hDYr8W34WmAFKpmK4Gfwj
```

```
TRANSACTION
  outcome              failed
  error                6040 BuySlippageBelowMinBaseAmountOut  [full]
                       buy: slippage - would buy less tokens than expected min_base_amount_out
  failing instruction  #4
```

---

## The thing that makes it different

Most decoders answer every question. Opsis refuses to answer questions it cannot
answer honestly, and says so explicitly.

Every decoded value carries a confidence marker of `full`, `partial`, or `raw`.
That marker is a TypeScript literal type per union variant, so a value of the
type cannot exist without one. Honest degradation is a compiler guarantee, not a
convention.

The sharpest case is error resolution. Anchor programs number user-defined
errors from 6000 upward and reserve everything below for framework errors. It is
tempting to resolve any code in those bands against Anchor's tables. Opsis will
not, unless the program has *attested* that it is an Anchor program, by emitting
an `AnchorError` log line or by having a loaded IDL.

Two of the recorded fixtures show both directions of that rule:

| Fixture | Code | Anchor table has it? | Opsis says |
| --- | --- | --- | --- |
| `02-anchor-user-error` | 6040 | Not loaded, no IDL | **Resolved** with name and message, read verbatim from the program's own `AnchorError` log line |
| `04-unattested-band-collision` | 5000 | Yes, `Deprecated` | **Unresolved**, reason `unattested-namespace`, confidence `raw` |

Same tool, same code bands, opposite answers, both correct. Fixture 04 is the
one worth dwelling on: Opsis has the Anchor framework table, the code sits
squarely inside the framework band, and it still declines, because the program
never claimed to be an Anchor program. A tool that answered there would be
confidently wrong, and that is the failure mode this project exists to avoid.

Of the five recorded failures in the test suite, exactly one resolves to a human
message. The other four report the numeric code and state why they could not go
further. That ratio is the product, not a limitation of it.

---

## Setup

Requires Node.js **[CONFIRM: 20]** or later. No wallet, no API key, no funds.

```bash
git clone https://github.com/shrooms08/opsis.git
cd opsis
npm install
```

`npm install` builds the project automatically via the `prepare` script, so the
CLI is ready immediately with no separate build step.

```bash
node bin/opsis.js --help
```

---

## Usage

```
opsis <signature> [options]

  --json           write the analysis to stdout as canonical JSON
  --rpc-url <url>  RPC endpoint (default: $OPSIS_RPC_URL, else mainnet-beta)
  --idl-dir <dir>  directory of Anchor IDL JSON files to load for decoding
  -V, --version    print the version
  -h, --help       print this help
```

**Exit codes**

| Code | Meaning |
| --- | --- |
| `0` | Analysis completed, transaction succeeded on chain |
| `1` | Analysis completed, transaction failed on chain |
| `2` | Usage or input error |
| `3` | Fetch or fixture error |

Exit 1 is a successful run reporting an on-chain failure, which is why the
analysis still goes to stdout. Diagnostics go to stderr on every path, so stdout
stays clean for piping.

```bash
opsis <signature> --json | jq .failure
```

---

## Testing

**The test suite is the point.** A reviewer can run Opsis and see output. What
they cannot easily do, without deep Solana knowledge, is tell whether that output
is *correct*. The suite closes that gap.

```bash
npm test
```

**866 tests across 32 files, in under three seconds, with the network
disconnected.** Offline is enforced rather than assumed: a network interceptor
throws on any outbound request during the run.

Six real mainnet transactions are recorded verbatim as golden fixtures. Each
directory holds the raw RPC response (`input.json`), a description of what the
case proves (`meta.json`), and the exact expected analysis (`expected.json`).
The harness runs the whole pipeline end to end and compares, with no internal
module mocked.

| Fixture | What it pins |
| --- | --- |
| `01-success-cpi-heavy` | A success at CPI depth 3, a v0 message with 7 writable and 15 readonly lookup-table addresses, and two token mints at different decimal scales |
| `02-anchor-user-error` | Tier-1 attestation: an error resolved from its own log line with no IDL loaded |
| `03-program-table-error` | Namespace selection by failing program ID. Code 1 exists in the System, SPL Token, and ATA tables simultaneously; the ATA table defines only code 0, so the honest answer is `not-in-table` |
| `04-unattested-band-collision` | The negative case: a code inside Anchor's framework band, refused for lack of attestation |
| `06-nested-cpi-failure` | Top-level failure attribution. Solana's `InstructionError` carries only a top-level index, so the mark lands on exactly one depth-0 node and on none of its six descendants |
| `07-unknown-program` | Full degradation: no decoder, no table, no IDL. Raw bytes preserved, reason stated |

**Every golden file was reviewed by hand before promotion.** A golden file
generated by the code it is meant to check proves nothing until a human reads it.
That review is the only manual step in the build, and a repository hook
(`.kiro/hooks/golden-guard.json`) blocks the agent from rewriting an
`expected.json` to make a failing test pass.

### Running it offline against the recorded transactions

The six recorded responses are committed to `fixtures/`, keyed by signature. When
`./fixtures/<signature>.json` exists, Opsis reads it and makes no network
request. **Disconnect your network and these still work:**

```bash
node bin/opsis.js 4MqxZnZ3VXjTK1zARqA5Z6k4MupZkHESTM7kJX3itwc7NLWWZAbdpeKiwcYrRRPPtT4hDYr8W34WmAFKpmK4Gfwj
node bin/opsis.js 2CuHMnrN5g66nwquYDCC7o1pchFqjKwgaZZtUWDGaji51ebVtxh8cnCkMjeh4ieUUDLevvLkhrVrTihkZGCGXE9f
node bin/opsis.js 3Pyx763LzZFMszCXgRoAhYByJ6vDyeSmhkzb16hmuUTRw9r9LLDaysydsjHHNecZiHakzJW7Cb9WekRySbL4xPd
node bin/opsis.js 5xis1MD1MQXM7xtrCUESivrizTtfdq14B7huubfoaRM3FbcxWe6CN6wxW6G4m3DQmhWgUngFXMh63Sx3AChVJgkZ
node bin/opsis.js 5htUvgnugDJHSwsoZUxiAJifCXjBUtNMJnjU5MPD8KokhwVNrpZkoSqk4E1kTL4WfjGsSYwndyNwfSedKG8ipkTA
node bin/opsis.js Hh5n4LsC5F6HRAphoZ1siE2tEcDh7ZynRcWQV3cA6mUoG2E4paPZgtdEsuNyo9rzLA3CyeqN45v72SNAr6ykUve
```

The first two are the attestation pair from the table above.

---

## An arithmetic check worth mentioning

Per-instruction compute units are derived from the `consumed N of M compute
units` log lines. Native programs never emit that line, so those instructions
report `available: false` at `raw` confidence rather than a guessed number.

That leaves an unattributed remainder in every transaction. Across all six
fixtures, the remainder is **exactly 150 multiplied by the number of executed
native top-level instructions** (300, 600, 300, 750, 450, 300). 150 is the fixed
per-instruction charge the runtime applies and never logs.

No code in Opsis knows the number 150. An implementation that guessed at compute
attribution could not produce that result six times.

---

## Correctness decisions

**No floating point anywhere in the analysis.** Lamport values, token amounts,
and compute units are decimal strings. A `u64` lamport balance above 2^53 rounds
silently in a JavaScript `number`, and `bigint` is not JSON-representable, which
would force a custom serializer onto the exact path the golden tests depend on.
Arithmetic happens in `bigint` and narrows to a decimal string at the boundary.

**Token amounts render at their own scale, never a default.** A mint's decimals
are bound to its amount as a known/unknown union, so a renderer cannot format an
amount without its scale, nor read a scale without handling absence. When
decimals are missing, Opsis prints raw base units, labels them as such, and marks
the value `partial`. Assuming 6 or 9 would report a number off by orders of
magnitude.

**Read-only is enforced, not promised.** A TypeScript AST walk over `src/` fails
the build if any call site constructs, signs, or sends a transaction. A text
search was rejected because it would match this README.

**Address lookup tables are resolved.** Account roles come from the union of
static keys and `loadedAddresses`, with writable and readonly determined by which
array an address appears in, not by the message header. Lookup-table addresses
are never signers.

---

## What is supported

**Instruction decoders:** System Program, SPL Token, SPL Associated Token
Account, Compute Budget. Anchor programs decode from a loaded IDL via
`--idl-dir`, with the explicit `discriminator` array preferred over the computed
`sha256("global:" + name)` so Anchor 0.30+ programs with overridden
discriminators resolve correctly. Both the pre-0.30 and 0.30+ IDL layouts are
accepted.

**Error tables:** System Program, SPL Token, SPL Associated Token Account, and
Anchor framework errors. Anchor user-defined errors resolve from an `AnchorError`
log line or a loaded IDL, subject to attestation.

**Anything else** degrades to raw: named program where known, raw instruction
bytes preserved, explicit reason recorded, confidence `raw`.

## What is not supported

Stated plainly, because a tool that hides its limits is the thing this project
argues against.

- **Per-line log attribution.** Logs are captured verbatim and rendered, but
  individual lines are not attributed to the instruction that emitted them.
- **Nested CPI failure attribution.** `cpiAttribution` is always `null`. Solana's
  `InstructionError` carries only a top-level index; going deeper requires log
  inference, which would carry `partial` confidence at best.
- **Per-instruction compute units for nested instructions.** Top-level values are
  derived from depth-1 log scopes. Nested ones report `available: false`.
- **On-chain IDL fetching.** IDLs load from a local directory only.
- **Transaction simulation.** Opsis analyzes what happened, not what would.

---

## RPC endpoints, costs, and rate limits

**Opsis is free and requires no API key.** It makes at most one
`getTransaction` call per invocation, and zero when a local fixture exists.

The default endpoint is `https://api.mainnet-beta.solana.com`, which is free and
heavily rate limited. It is fine for occasional use and will return HTTP 429
under repeated use. Supply your own with `--rpc-url` or `OPSIS_RPC_URL`:

```bash
export OPSIS_RPC_URL='https://your-endpoint'
```

Requests time out after 10 seconds. Rate limiting is identified explicitly rather
than reported as a generic network failure.

**Reviewers need none of this.** The six committed fixtures cover every feature
offline.

---

## How Kiro was used

Opsis was built entirely in Kiro, spec-first. The `.kiro` directory is the record
and is worth reading before the source.

**Steering** (`.kiro/steering/`) was hand-written before any code. `product.md`
states the hard boundaries — read-only, deterministic, honest degradation,
offline-capable — and the constraint everything defers to: a reviewer with no
Solana knowledge must clone, install, test, and see the tool prove its own
correctness in under two minutes with no network. `tech.md` fixes the stack and
records *why* TypeScript over Rust: `npx` gives a reviewer a working tool in one
command, where a four-minute `cargo` build fails that constraint.

**Specs** (`.kiro/specs/solana-transaction-analyzer/`) drove the whole build
through Kiro's three-phase workflow.

- `requirements.md` — 22 requirements, 167 acceptance criteria in EARS notation
- `design.md` — architecture, data models, and 45 correctness properties, each
  citing the requirements it validates
- `tasks.md` — 66 tasks in a dependency graph, executed in waves

Running Kiro's **Analyze Requirements** on the first draft surfaced 17 items,
several of them real contradictions. Two of its proposed resolutions were
overridden because they conflicted with the steering files: one would have let a
golden mismatch report a diff and still exit zero, and one would have extended an
error table past its known entries, which is guessing. Both overrides are
recorded in the spec.

The attestation rule that defines this tool did not come from the original
requirements. It emerged during design, when the range-based dispatch rule was
traced against a recorded fixture and produced a confident wrong answer.
Fixture 04 exists because of that trace.

**Hooks** (`.kiro/hooks/`) encode the two invariants most likely to be violated
under time pressure:

- `golden-guard.json` — blocks writes to a hand-reviewed `expected.json`. A
  `PreToolUse` matcher tests against the *tool name*, not the file path, so the
  path check lives in the action. Verified against the installed Kiro build
  rather than the documentation, because a hook that silently never fires is
  worse than no hook.
- `decoder-confidence-guard.json` — fires when a new decoder file is created, and
  restates that decoders are total, never throw, and never upgrade `partial` to
  `full` to tidy the output.

**Task execution** ran in Kiro's dependency waves. Fixtures were recorded before
any decoder existed, so every decoder was written against real mainnet responses
rather than invented ones.

---

## Attribution

| Dependency | Purpose | License |
| --- | --- | --- |
| [`@solana/web3.js`](https://github.com/solana-labs/solana-web3.js) | RPC client, transaction and message types | Apache-2.0 |
| [`bs58`](https://github.com/cryptocoinjs/bs58) | Base58 encoding and decoding | MIT |
| [`commander`](https://github.com/tj/commander.js) | Argument parsing | MIT |
| [`picocolors`](https://github.com/alexeyraspopov/picocolors) | Terminal color | ISC |
| [`vitest`](https://github.com/vitest-dev/vitest) | Test runner | MIT |
| [`fast-check`](https://github.com/dubzzz/fast-check) | Property-based testing | MIT |
| [`typescript`](https://github.com/microsoft/TypeScript) | Language and compiler | Apache-2.0 |

Anchor framework error codes are derived from
[`anchor-lang`](https://github.com/coral-xyz/anchor) (Apache-2.0). SPL program
error codes are derived from
[`solana-program-library`](https://github.com/solana-labs/solana-program-library)
(Apache-2.0).

Fixture data consists of public Solana mainnet transactions, recorded verbatim
from a public RPC endpoint.

Built with [Kiro](https://kiro.dev) for the Ready, Spec, Ship Hackathon.

---

## License

**[CONFIRM: MIT]**

Built by Minos ([@shrooms08](https://github.com/shrooms08)).
