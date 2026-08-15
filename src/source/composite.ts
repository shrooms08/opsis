/**
 * `CompositeSource` — fixtures first, then the network. Requirements 2.6, 2.8, 10.1, 10.3, 10.4.
 *
 * The whole module is one three-way branch, and the branch is the point.
 * Requirements 2.6/2.8 and 10.3/10.4 draw a sharp line that a two-way
 * "did we get a fixture?" test would erase:
 *
 * - **Fixture absent** → fall through to the RPC source (Req 2.6, 10.4). Nothing
 *   was recorded, so asking the network is the only way to answer.
 * - **Fixture present and loads** → use it, and issue no network request at all
 *   (Req 10.1). Not "prefer the fixture": the RPC source is never touched, which
 *   is what makes a run with connectivity disabled succeed (Req 10.6).
 * - **Fixture present and fails to load, for any reason** → `fixture-unreadable`
 *   carrying the path and the reason, **with no network fallback** (Req 2.8,
 *   10.3).
 *
 * That last case is the one worth being explicit about. Falling back to the
 * network when a fixture was supposed to answer would be the friendlier-looking
 * behavior and the wrong one twice over: it destroys offline reproducibility,
 * since the run's result would depend on connectivity the fixture existed to
 * remove, and it makes a corrupt fixture look like a passing test, since the
 * suite would go green on live data while the recorded ground truth silently
 * rotted. A broken fixture is a maintainer's problem and has to be reported as
 * one.
 *
 * The composite adds no normalization of its own. It returns whichever source
 * answered, verbatim, and records nothing about which one that was — the pipeline
 * below cannot tell, which is what design.md's Property 6 requires.
 */

import type { Base58Signature } from '../model/analysis.js';
import type { FixtureLoader, SourceResult, TransactionSource } from './index.js';

export class CompositeSource implements TransactionSource {
  private readonly fixtures: FixtureLoader;
  private readonly rpc: TransactionSource;

  constructor(fixtures: FixtureLoader, rpc: TransactionSource) {
    this.fixtures = fixtures;
    this.rpc = rpc;
  }

  async fetch(signature: Base58Signature): Promise<SourceResult> {
    const lookup = await this.fixtures.load(signature);

    switch (lookup.kind) {
      case 'loaded':
        return { ok: true, response: lookup.response };

      case 'unreadable':
        return {
          ok: false,
          error: { kind: 'fixture-unreadable', path: lookup.path, detail: lookup.detail },
        };

      case 'absent':
        return this.rpc.fetch(signature);
    }
  }
}
