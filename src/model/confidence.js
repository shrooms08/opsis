/**
 * The confidence algebra.
 *
 * `Confidence` is defined here rather than in `analysis.ts` so the ordering and
 * the fold that depend on it live beside the type they constrain. `analysis.ts`
 * re-exports it, so the data model's export surface is unchanged.
 */
/** Rank for comparison only. Never serialized. */
const RANK = { full: 2, partial: 1, raw: 0 };
/**
 * Fold over a container's own marker plus its children's markers.
 *
 * A container's confidence is the minimum, under `full > partial > raw`, of its
 * own intrinsic confidence and the confidence of every one of its children.
 * Confidence is never upgraded: the result is monotonically non-increasing as
 * propagation moves up the tree. `assemble.ts` is the single place propagation
 * happens. Requirement 11.2, 11.4.
 */
export function minConfidence(own, children) {
    return children.reduce((acc, c) => (RANK[c] < RANK[acc] ? c : acc), own);
}
