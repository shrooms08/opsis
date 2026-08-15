/**
 * The Analysis data model — the single contract between decode and render.
 *
 * `expected.json` in every fixture directory is the canonical serialization of
 * one `Analysis`, so a change to any type here is a change to every golden
 * file, deliberately.
 *
 * Two conventions run through the whole file:
 *
 * - Lamports and token amounts are decimal `string`s, not `number` and not
 *   `bigint`. `number` silently rounds a `u64`; `bigint` is not
 *   JSON-representable. Arithmetic is done in `bigint` and narrowed back to a
 *   string at the boundary. Requirements 9.2, 13.8, 20.7, 20.8.
 * - Absence has two spellings. `T | null` is always present and states "we
 *   looked and it is not there". `?: T` is omitted from the serialization when
 *   `undefined`, per Requirement 13.7.
 */
export {};
