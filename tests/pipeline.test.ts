/**
 * Unit tests for the pipeline over the recorded responses.
 *
 * These are not the golden harness — nothing here reads or compares an
 * `expected.json`, which is task 4.10's job. They check the two things that must
 * hold before a golden file is worth authoring: the pipeline turns every recorded
 * response into an `Analysis` without throwing, and it does so deterministically
 * (Req 9.1).
 *
 * The third block below is about **wiring**, and it is deliberately shallow. Each
 * stage — error resolution, compute, lamport balances, token balances — has its
 * own unit tests that check what it computes; nothing is re-checked here. What is
 * checked is that the value reaching the `Analysis` is the one that stage
 * produced, because every one of those seams typechecks perfectly while dropping
 * the stage's output on the floor. An unwired `compute` reads as
 * `available: false`, an unwired `accountKeys` has empty `referencedBy` lists, and
 * an unwired `failure` is `null` on a failed transaction. All three are
 * well-formed values, so only an assertion against the response itself can tell a
 * wired stage from an absent one.
 */

import { describe, expect, it } from 'vitest';

import type { InstructionNode } from '../src/model/analysis.js';
import type { RawTransactionResponse } from '../src/model/rawResponse.js';
import { analyzeTransaction } from '../src/pipeline.js';
import { asTransactionResponse } from '../src/source/index.js';
import { goldenCases } from './source/support/golden.js';

function responseOf(document: unknown): RawTransactionResponse {
  const checked = asTransactionResponse(document);
  if (!checked.ok) throw new Error(`recorded fixture is not a transaction response: ${checked.detail}`);
  return checked.response;
}

describe('analyzeTransaction over the recorded fixtures', () => {
  for (const recorded of goldenCases()) {
    describe(recorded.name, () => {
      const response = responseOf(recorded.document);

      it('produces an Analysis with the recorded signature and instruction tree', () => {
        const analysis = analyzeTransaction({ response });

        expect(analysis.signature).toBe(recorded.signature);
        expect(analysis.instructions.length).toBe(
          response.transaction.message.instructions.length,
        );
        const orders = analysis.instructions.map((node) => node.order);
        expect(orders).toEqual([...orders].sort((a, b) => a - b));
        expect(analysis.accountKeys.map((entry) => entry.index)).toEqual([
          ...analysis.accountKeys.keys(),
        ]);
      });

      it('serializes identically on two runs', () => {
        const first = JSON.stringify(analyzeTransaction({ response }));
        const second = JSON.stringify(analyzeTransaction({ response }));

        expect(second).toBe(first);
      });

      it('reports the outcome, the failure report, and the resolved error as one story', () => {
        const analysis = analyzeTransaction({ response });
        const failed = (response.meta?.err ?? null) !== null;

        // Requirement 22.1, and the invariant that makes `Analysis` readable:
        // `failure` is non-null exactly when the transaction failed (Req 5).
        expect(analysis.outcome.succeeded).toBe(!failed);
        expect(analysis.failure === null).toBe(!failed);
        // Requirement 6.4 puts the error in both places, and it must be the same
        // resolution rather than a second one.
        expect(analysis.outcome.error).toBe(analysis.failure?.error ?? null);
      });

      it('carries the compute total, the balances, and the account references from their stages', () => {
        const analysis = analyzeTransaction({ response });
        const meta = response.meta;

        // `meta.computeUnitsConsumed` is present in all six recordings, so
        // `available: false` here would mean `analyze/compute.ts` never ran
        // (Req 8.1, 8.5).
        expect(analysis.compute.total).toEqual({
          available: true,
          value: meta?.computeUnitsConsumed,
          confidence: 'full',
        });

        // One row per account index in `preBalances`/`postBalances` (Req 7.8).
        expect(analysis.lamportBalances.length).toBe(meta?.preBalances?.length);

        // `referencedBy` is populated only by `analyzeLamportBalances`, so an
        // empty list on every entry would mean `keys.entries` reached the output
        // instead of `balances.accountKeys` (Req 7.11).
        expect(analysis.accountKeys.some((entry) => entry.referencedBy.length > 0)).toBe(true);

        // Token rows exist exactly when the recording has token balances to join
        // (Req 20.1). Every fixture has some, so this is a real check in all six.
        expect(analysis.tokenBalances.length > 0).toBe((meta?.preTokenBalances?.length ?? 0) > 0);
      });

      it('decodes at least one instruction through the built-in ladder', () => {
        // No IDL is passed, so every decode comes from a built-in or from the
        // `Unknown` floor. Each recording contains at least one System Program or
        // SPL Token instruction, so a registry with its built-in rung unwired
        // would show up here as zero named decodes (Req 4.2).
        const analysis = analyzeTransaction({ response });

        const named: string[] = [];
        const walk = (nodes: readonly InstructionNode[]): void => {
          for (const node of nodes) {
            if (node.decode.kind !== 'raw') named.push(node.decode.name);
            walk(node.inner);
          }
        };
        walk(analysis.instructions);

        expect(named.length).toBeGreaterThan(0);
        // Nothing named `Unknown` can carry a `builtin` source: the floor is the
        // only producer of that name, and it is not a decoder.
        expect(named).not.toContain('Unknown');
      });

      it('carries no timestamp, duration, or provenance field', () => {
        const analysis = analyzeTransaction({ response });

        expect(Object.keys(analysis).sort()).toEqual([
          'accountKeys',
          'compute',
          'failure',
          'instructions',
          'lamportBalances',
          'logs',
          'messageVersion',
          'outcome',
          'signature',
          'tokenBalances',
        ]);
      });
    });
  }
});
