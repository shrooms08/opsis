/**
 * Help and version output, checked against the parser rather than against a
 * transcription of it. Requirements 17.2, 17.3, 17.4, 17.6, 22.6.
 *
 * `tests/cli.test.ts` already pins the *values*: that `--version` writes the
 * `package.json` version and exits 0, that `--help` lists the five flags Opsis
 * ships today and contains an example, that `--version` outranks `--help` in
 * either order, and that an unrecognized flag names itself on stderr with an
 * empty stdout and exit 2. This file does not repeat any of that.
 *
 * What it adds is the direction those tests cannot cover. A test that names five
 * flags keeps passing after a sixth is registered with no description, which is
 * the regression Requirement 17.3 exists to catch. So every assertion here
 * enumerates the flag set instead of stating it, and adding an undocumented flag
 * to `buildProgram` fails a test in this file without anyone editing this file.
 *
 * ## Why the flag set is read out of the help text
 *
 * `src/cli.ts` does not export `buildProgram`, and the `Command` it builds is
 * local to one `parseArgv` call, so the registered options are not reachable as
 * objects from a test. Rather than change `src/`, the set is recovered from the
 * `Options:` block of the help text — which commander generates by walking the
 * options actually registered on the program, so a newly registered flag appears
 * there with no help-text edit. Two things keep that from being circular or
 * vacuous:
 *
 * - {@link describe} `the help-text reader` runs the same reader over a
 *   purpose-built commander program with one documented and one undocumented
 *   flag, and asserts it reports exactly that. The reader is therefore known to
 *   detect the regression it is here to detect, including across commander's
 *   description wrapping.
 * - `documents no flag the parser rejects` feeds every recovered flag back
 *   through `parseArgv`. Help ⊇ registered holds by construction; that test
 *   supplies help ⊆ registered, so the documented set and the accepted set are
 *   pinned to each other in both directions.
 *
 * Nothing here performs I/O beyond `parseArgv`'s own `package.json` read, and no
 * stream is captured: the `info` variant of `ParseResult` carries the help text
 * as data.
 */

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { PROGRAM_NAME, parseArgv } from '../src/cli.js';
import { validateSignature } from '../src/signature.js';

// ---------------------------------------------------------------------------
// Reading a commander help block back into entries
// ---------------------------------------------------------------------------

/** One `term  description` row of a commander help section. */
interface HelpEntry {
  /** The flag spellings and any value placeholder, e.g. `-V, --version`. */
  readonly term: string;
  /** The description, with wrapped continuation lines rejoined. */
  readonly description: string;
}

/**
 * A section term begins at exactly two spaces of indent; the description, when
 * present, is separated from the term by two or more spaces. The term itself may
 * contain single spaces (`-V, --version`, `--rpc-url <url>`), which is why the
 * split is on run length rather than on the first space.
 */
const TERM_LINE = /^ {2}(?<term>\S.*?)(?: {2,}(?<description>\S.*))?$/u;

/**
 * A wrapped description continues at the term column, which is always deeper
 * than two spaces. Disjoint from {@link TERM_LINE} by construction, so no line
 * can be read as both.
 */
const CONTINUATION_LINE = /^ {3,}(?<text>\S.*)$/u;

/** The lines of one `Heading:` section, up to the blank line that ends it. */
function sectionLines(help: string, heading: string): readonly string[] {
  const lines = help.split('\n');
  const start = lines.indexOf(`${heading}:`);
  if (start === -1) return [];

  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') break;
    body.push(line);
  }
  return body;
}

/** The `term  description` rows of a help section, wrapping undone. */
function entriesIn(help: string, heading: string): readonly HelpEntry[] {
  const collected: { term: string; parts: string[] }[] = [];

  for (const line of sectionLines(help, heading)) {
    const term = TERM_LINE.exec(line)?.groups;
    if (term?.['term'] !== undefined) {
      collected.push({
        term: term['term'],
        parts: term['description'] === undefined ? [] : [term['description']],
      });
      continue;
    }

    const continued = CONTINUATION_LINE.exec(line)?.groups?.['text'];
    const last = collected.at(-1);
    if (continued !== undefined && last !== undefined) last.parts.push(continued);
  }

  return collected.map((entry) => ({
    term: entry.term,
    description: entry.parts.join(' ').trim(),
  }));
}

/** The `$ opsis …` invocations of the `Examples:` section. */
function examplesIn(help: string): readonly string[] {
  const invocations: string[] = [];
  for (const line of sectionLines(help, 'Examples')) {
    const invocation = /^ {2}\$ (?<invocation>\S.*)$/u.exec(line)?.groups?.['invocation'];
    if (invocation !== undefined) invocations.push(invocation);
  }
  return invocations;
}

// ---------------------------------------------------------------------------
// The two texts under test, taken as data off ParseResult
// ---------------------------------------------------------------------------

/** A well-formed signature, so a probe argv fails for flag reasons only. */
const PROBE_SIGNATURE = '5htUvgnugDJHSwsoZUxiAJifCXjBUtNMJnjU5MPD8KokhwVNrpZkoSqk4E1kTL4WfjGsSYwndyNwfSedKG8ipkTA';

/** The text `--help` produces. */
function helpText(): string {
  const parsed = parseArgv(['--help']);
  if (parsed.kind !== 'info' || parsed.request !== 'help') {
    throw new Error(`expected --help to be served as info, got ${parsed.kind}`);
  }
  return parsed.text;
}

/** The stderr payload an unrecognized flag produces (Req 17.6). */
function usageErrorText(): string {
  const parsed = parseArgv([PROBE_SIGNATURE, '--no-such-flag']);
  if (parsed.kind !== 'error') {
    throw new Error(`expected an unrecognized flag to be a usage error, got ${parsed.kind}`);
  }
  return parsed.message;
}

/** The registered options, as commander itself renders them. */
function registeredOptions(): readonly HelpEntry[] {
  return entriesIn(helpText(), 'Options');
}

/** The long spelling of a flag term, e.g. `--version` from `-V, --version`. */
function longFlagOf(term: string): string {
  const flags = term
    .split(/[\s,]+/u)
    .filter((token) => token.startsWith('-') && !token.startsWith('<'));
  const long = flags.find((token) => token.startsWith('--')) ?? flags.at(-1);
  if (long === undefined) throw new Error(`no flag spelling in term ${JSON.stringify(term)}`);
  return long;
}

/** Whether the term declares a value placeholder, e.g. `--idl-dir <dir>`. */
function takesValue(term: string): boolean {
  return /<[^>]+>/u.test(term);
}

// ---------------------------------------------------------------------------
// The reader, checked against a program built to break it
// ---------------------------------------------------------------------------

describe('the help-text reader', () => {
  /**
   * A program with one documented flag, one registered with an empty
   * description, and one long enough to force commander to wrap. Nothing about
   * Opsis's own flags is restated here — this is a fixture for the reader.
   */
  function probeProgram(helpWidth: number): string {
    const program = new Command();
    program
      .name('probe')
      .option('--documented <value>', 'a flag whose purpose is stated')
      .option('--undocumented <value>', '')
      // The likelier mistake: the description argument left off entirely.
      .option('--omitted <value>')
      .option(
        '--wrapped',
        'a description long enough that commander must break it across more than one line of help output',
      );
    program.configureHelp({ helpWidth });
    return program.helpInformation();
  }

  it('recovers the term and description of every registered option', () => {
    const entries = entriesIn(probeProgram(80), 'Options');
    const terms = entries.map((entry) => entry.term);

    // commander adds `-h, --help` of its own, so five rows in total.
    expect(terms).toStrictEqual([
      '--documented <value>',
      '--undocumented <value>',
      '--omitted <value>',
      '--wrapped',
      '-h, --help',
    ]);
  });

  it('reports an empty description as empty and a stated one as non-empty', () => {
    const byTerm = new Map(entriesIn(probeProgram(80), 'Options').map((e) => [e.term, e]));

    expect(byTerm.get('--undocumented <value>')?.description).toBe('');
    expect(byTerm.get('--omitted <value>')?.description).toBe('');
    expect(byTerm.get('--documented <value>')?.description).toBe(
      'a flag whose purpose is stated',
    );
  });

  it('rejoins a description commander wrapped across lines', () => {
    // At width 48 the long description certainly wraps; a reader that dropped
    // continuation lines would still find a non-empty description here, so the
    // assertion is on the whole rejoined text.
    const byTerm = new Map(entriesIn(probeProgram(48), 'Options').map((e) => [e.term, e]));

    expect(byTerm.get('--wrapped')?.description).toBe(
      'a description long enough that commander must break it across more than one line of help output',
    );
  });

  it('never mistakes a wrapped continuation line for a new option', () => {
    for (const width of [40, 48, 60, 80, 200]) {
      const terms = entriesIn(probeProgram(width), 'Options').map((entry) => entry.term);

      expect(terms).toHaveLength(5);
    }
  });
});

// ---------------------------------------------------------------------------
// Requirement 17.3 — a description for every registered flag
// ---------------------------------------------------------------------------

describe('every registered flag is documented', () => {
  it('finds the option block rather than passing vacuously', () => {
    const options = registeredOptions();

    // A floor, not a count: registering a sixth flag must not fail this, while
    // a reader that found nothing must.
    expect(options.length).toBeGreaterThanOrEqual(5);
    expect(options.map((option) => longFlagOf(option.term))).toContain('--json');
  });

  it('gives every flag a non-empty description', () => {
    // Requirement 17.3. Derived from the parser's own option list, so a flag
    // added to `buildProgram` with no description fails here with no edit to
    // this file.
    const undocumented = registeredOptions()
      .filter((option) => option.description === '')
      .map((option) => option.term);

    expect(undocumented).toStrictEqual([]);
  });

  it('gives the positional argument a description too', () => {
    // Requirement 17.2's "command syntax": the one positional carries its own
    // explanation, not just its name.
    const args = entriesIn(helpText(), 'Arguments');

    expect(args.length).toBeGreaterThanOrEqual(1);
    for (const argument of args) {
      expect(argument.description).not.toBe('');
    }
  });

  it('documents no flag the parser rejects', () => {
    // The closing direction. The option list is read out of the help text, so
    // help ⊇ registered holds by construction; feeding each recovered flag back
    // through `parseArgv` supplies help ⊆ registered. Together: what is
    // documented is exactly what is accepted.
    for (const option of registeredOptions()) {
      const flag = longFlagOf(option.term);
      const argv = takesValue(option.term)
        ? [PROBE_SIGNATURE, flag, 'probe-value']
        : [PROBE_SIGNATURE, flag];

      const parsed = parseArgv(argv);

      const rejected =
        parsed.kind === 'error' && parsed.error.kind === 'unrecognized-flag'
          ? parsed.error.flag
          : null;
      expect(rejected).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Requirements 17.6, 22.6 — the same flag list on the error path
// ---------------------------------------------------------------------------

describe('the usage instructions on the error path', () => {
  it('document every flag the help text documents', () => {
    // Requirement 17.6 asks for "usage instructions" after the error, and this
    // is what makes that more than a syntax line: the stderr payload carries the
    // full option list, derived rather than listed, so a flag documented only in
    // one of the two paths fails here.
    const stderrText = usageErrorText();
    const missing = registeredOptions()
      .map((option) => longFlagOf(option.term))
      .filter((flag) => !stderrText.includes(flag));

    expect(missing).toStrictEqual([]);
  });

  it('leads with the offending flag before the usage instructions', () => {
    const stderrText = usageErrorText();

    const errorAt = stderrText.indexOf("unknown option '--no-such-flag'");
    const usageAt = stderrText.indexOf(`Usage: ${PROGRAM_NAME}`);
    expect(errorAt).toBeGreaterThanOrEqual(0);
    expect(usageAt).toBeGreaterThan(errorAt);
  });
});

// ---------------------------------------------------------------------------
// Requirement 17.4 — the example is a runnable invocation
// ---------------------------------------------------------------------------

describe('the help example', () => {
  it('names the program on every example line', () => {
    const examples = examplesIn(helpText());

    expect(examples.length).toBeGreaterThanOrEqual(1);
    for (const example of examples) {
      expect(example.split(/\s+/u)[0]).toBe(PROGRAM_NAME);
    }
  });

  it('demonstrates analysis of a real signature, not a placeholder', () => {
    // Requirement 17.4. The example's argument is put through the same
    // validation a user's argument goes through, so a placeholder that drifted
    // into the example — or a truncated signature — fails here. `<signature>` in
    // the flag-illustrating examples is fine; at least one line must carry
    // something Opsis would actually accept.
    const analysed = examplesIn(helpText())
      .map((example) => example.split(/\s+/u)[1])
      .filter((argument): argument is string => argument !== undefined)
      .filter((argument) => validateSignature(argument).ok);

    expect(analysed.length).toBeGreaterThanOrEqual(1);
  });

  it('reaches the user on stdout for --help and on stderr after an error', () => {
    // Requirement 22.6 in both directions, for usage output specifically: the
    // `info` result is what `main` writes to stdout and the `error` message is
    // what it writes to stderr, and the example survives into both.
    const example = examplesIn(helpText())[0];
    if (example === undefined) throw new Error('expected at least one example');

    expect(helpText()).toContain(`$ ${example}`);
    expect(usageErrorText()).toContain(`$ ${example}`);
  });
});
