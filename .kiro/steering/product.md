---
inclusion: always
---

# Opsis

## What this is

A read-only command-line tool that takes a Solana transaction signature and
explains what happened, with emphasis on why it failed.

The name is Greek *opsis*, "sight" — the root inside *autopsy*, which means
"to see with one's own eyes," not "to cut open a corpse." Opsis does not guess
or infer. It shows what is already there.

## The problem

A failed Solana transaction gives the developer this:

    Error processing Instruction 3: custom program error: 0x1771

No program named, no instruction named, no cause. Resolving it by hand means
finding which program owns instruction 3, converting hex to decimal, working out
which error namespace applies, and reading an IDL. Every Solana developer does
this repeatedly and it takes minutes each time.

## What it produces

Given a signature: the instruction tree including CPIs, instruction names where
resolvable, the failing instruction clearly marked, the error resolved against
the correct namespace, account roles, balance deltas, and compute units used.

## Hard boundaries — product decisions, not limitations

**Read-only.** Never signs, sends, or simulates. No wallet, no keys, no funds.
There is no code path that constructs a transaction.

**Deterministic.** Same input bytes, same output bytes. Never calls a language
model. Never infers intent.

**Honest degradation.** Unknown program means Opsis says so and prints raw
instruction data. Every decoded object carries an explicit confidence marker of
full, partial, or raw. A partial decode is never presented as complete.

**Offline-capable.** Every feature must work against a recorded fixture with no
network. Anything that cannot run offline does not ship in v1.

## Out of scope for v1

Simulating hypothetical transactions, source-line mapping, any web interface,
any chain other than Solana, indexing or monitoring.

## The constraint everything defers to

A reviewer with no Solana knowledge must clone the repo, run one install command
and one test command, and see the tool prove its own correctness in under two
minutes with no network, no API key, and no wallet.
