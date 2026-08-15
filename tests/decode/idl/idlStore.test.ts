/**
 * `loadIdlDirectory`: indexing, the ways an IDL can be broken, and determinism.
 *
 * Requirements 18.1, 18.2, 18.3, 18.4, 9.6, 22.5.
 *
 * The behaviour under test is that **loading never fails**. Each broken file has
 * to produce one warning naming its path and its reason while every other file
 * in the directory still lands in the store — a bad IDL that took the good ones
 * with it would defeat the purpose of the flag. Warnings are asserted on the
 * returned store rather than on a captured stream, because this module does not
 * touch stderr; `cli.ts` writes them (see the deviation note in idlStore.ts).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadIdlDirectory } from '../../../src/decode/idl/idlStore.js';

const ADDRESS = 'Ea4kQfwLwmL2c8dNxrgTgQuqbC6jvpKPRJPUuBwgS8Ln';
const OTHER_ADDRESS = 'MEisE1HzehtrDpAAT8PnLHjpSSkRYakotTuJRPjTpo8';

/** A complete, valid legacy-format Anchor IDL. */
function validIdl(address: string = ADDRESS): Record<string, unknown> {
  return {
    version: '0.1.0',
    name: 'example_program',
    instructions: [
      {
        name: 'initialize',
        accounts: [
          { name: 'payer', isMut: true, isSigner: true },
          { name: 'state', isMut: true, isSigner: false },
        ],
        args: [{ name: 'amount', type: 'u64' }],
      },
    ],
    accounts: [
      { name: 'State', type: { kind: 'struct', fields: [{ name: 'total', type: 'u64' }] } },
    ],
    errors: [{ code: 6000, name: 'AmountTooSmall', msg: 'the amount is below the minimum' }],
    metadata: { address },
  };
}

/**
 * The same program, in the Anchor 0.30+ layout: `address` at the root, `name`
 * and `version` under `metadata` alongside `spec`.
 *
 * Only the three identity fields move. The 0.30 grammar changes inside
 * `instructions` and `accounts` are `idlDecoder.ts`'s business, so the bodies
 * here match the legacy fixture and the two are compared field by field.
 */
function idl030(address: string = ADDRESS): Record<string, unknown> {
  const legacy = validIdl(address);

  return {
    address,
    metadata: { name: 'example_program', version: '0.1.0', spec: '0.1.0' },
    instructions: legacy['instructions'],
    accounts: legacy['accounts'],
    errors: legacy['errors'],
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opsis-idl-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, content: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

describe('loadIdlDirectory: loading and indexing', () => {
  it('indexes a valid IDL by metadata.address and surfaces the fields consumers need', async () => {
    await write('example.json', validIdl());

    const store = await loadIdlDirectory(dir);

    expect(store.warnings).toEqual([]);
    expect(store.programIds).toEqual([ADDRESS]);

    const idl = store.get(ADDRESS);
    expect(idl).toBeDefined();
    expect(idl?.address).toBe(ADDRESS);
    expect(idl?.name).toBe('example_program');
    expect(idl?.version).toBe('0.1.0');
    expect(idl?.path).toBe(join(dir, 'example.json'));
    // The three fields tasks 6.5 and 6.10 consume.
    expect(idl?.instructions).toEqual([
      {
        name: 'initialize',
        accounts: [
          { kind: 'account', name: 'payer' },
          { kind: 'account', name: 'state' },
        ],
        args: [{ name: 'amount', type: 'u64' }],
      },
    ]);
    expect(idl?.errors).toEqual([
      { code: 6000, name: 'AmountTooSmall', msg: 'the amount is below the minimum' },
    ]);
    expect(idl?.accounts).toEqual([
      { name: 'State', type: { kind: 'struct', fields: [{ name: 'total', type: 'u64' }] } },
    ]);
  });

  it('returns undefined for a program with no loaded IDL', async () => {
    await write('example.json', validIdl());

    expect((await loadIdlDirectory(dir)).get(OTHER_ADDRESS)).toBeUndefined();
  });

  it('loads only .json files, skipping other extensions and subdirectories', async () => {
    await write('good.json', validIdl());
    await write('notes.txt', 'not an IDL');
    await write('backup.json.bak', JSON.stringify(validIdl(OTHER_ADDRESS)));
    await mkdir(join(dir, 'nested.json'));

    const store = await loadIdlDirectory(dir);

    expect(store.programIds).toEqual([ADDRESS]);
    // A directory named *.json is skipped rather than attempted, so it warns
    // about nothing.
    expect(store.warnings).toEqual([]);
  });

  it('defaults an absent errors or accounts array to empty rather than undefined', async () => {
    const minimal = validIdl();
    delete minimal['errors'];
    delete minimal['accounts'];
    await write('minimal.json', minimal);

    const idl = (await loadIdlDirectory(dir)).get(ADDRESS);

    expect(idl?.errors).toEqual([]);
    expect(idl?.accounts).toEqual([]);
  });
});

describe('loadIdlDirectory: the Anchor 0.30+ layout (Req 18.3, 18.4)', () => {
  it('indexes a 0.30-style IDL under the same program ID a legacy file would be', async () => {
    await write('example.json', idl030());

    const store = await loadIdlDirectory(dir);

    expect(store.warnings).toEqual([]);
    expect(store.programIds).toEqual([ADDRESS]);

    const idl = store.get(ADDRESS);
    expect(idl?.address).toBe(ADDRESS);
    expect(idl?.name).toBe('example_program');
    expect(idl?.version).toBe('0.1.0');
    expect(idl?.path).toBe(join(dir, 'example.json'));
  });

  it('surfaces instructions, errors, and accounts exactly as the legacy path does', async () => {
    await write('modern.json', idl030());
    const modern = (await loadIdlDirectory(dir)).get(ADDRESS);

    await rm(join(dir, 'modern.json'));
    await write('legacy.json', validIdl());
    const legacy = (await loadIdlDirectory(dir)).get(ADDRESS);

    // Tasks 6.5 and 6.10 consume the same three fields either way, so the two
    // loaded shapes differ only in the path they came from.
    expect(modern?.instructions).toEqual(legacy?.instructions);
    expect(modern?.errors).toEqual(legacy?.errors);
    expect(modern?.accounts).toEqual(legacy?.accounts);
  });

  it.each([
    ['address', '"address" or "metadata.address" is missing'],
    ['name', '"name" or "metadata.name" is missing'],
    ['version', '"version" or "metadata.version" is missing'],
  ])('warns when a 0.30-style file has no %s in either position', async (field, reason) => {
    const broken = idl030();
    if (field === 'address') {
      // A 0.30 file carries no `metadata.address`, so dropping the root one
      // leaves nothing to index by.
      delete broken['address'];
    } else {
      const metadata = { ...(broken['metadata'] as Record<string, unknown>) };
      delete metadata[field];
      broken['metadata'] = metadata;
    }
    const badPath = await write('broken.json', broken);

    const store = await loadIdlDirectory(dir);

    expect(store.programIds).toEqual([]);
    expect(store.warnings).toEqual([{ kind: 'file-invalid', path: badPath, reason }]);
  });

  it('accepts a file whose three identity values all sit at the root, with no metadata', async () => {
    const rooted: Record<string, unknown> = {
      ...idl030(),
      version: '0.1.0',
      name: 'example_program',
    };
    delete rooted['metadata'];
    await write('rooted.json', rooted);

    const store = await loadIdlDirectory(dir);

    // `metadata` is not required in itself: it is one of two places the loader
    // looks, and this file has everything the loader reads.
    expect(store.warnings).toEqual([]);
    expect(store.get(ADDRESS)?.name).toBe('example_program');
  });

  it('rejects a file whose two positions for a value disagree, rather than picking one', async () => {
    const conflicting: Record<string, unknown> = { ...idl030(), address: OTHER_ADDRESS };
    conflicting['metadata'] = { name: 'example_program', version: '0.1.0', address: ADDRESS };
    const badPath = await write('conflict.json', conflicting);

    const store = await loadIdlDirectory(dir);

    expect(store.programIds).toEqual([]);
    expect(store.warnings).toHaveLength(1);
    expect(store.warnings[0]?.path).toBe(badPath);
    expect(store.warnings[0]?.reason).toBe(
      `"address" is "${OTHER_ADDRESS}" but "metadata.address" is "${ADDRESS}"; ` +
        'the two disagree, so which one describes this program cannot be decided here',
    );
  });

  it('loads a legacy and a 0.30-style IDL for different programs from one directory', async () => {
    await write('a-legacy.json', validIdl());
    await write('b-modern.json', idl030(OTHER_ADDRESS));

    const store = await loadIdlDirectory(dir);

    expect(store.warnings).toEqual([]);
    expect(store.programIds).toEqual([ADDRESS, OTHER_ADDRESS].sort());
    expect(store.get(ADDRESS)?.path).toBe(join(dir, 'a-legacy.json'));
    expect(store.get(OTHER_ADDRESS)?.path).toBe(join(dir, 'b-modern.json'));
  });
});

describe('loadIdlDirectory: one bad IDL never fails the run (Req 18.4)', () => {
  it('warns on invalid JSON and keeps loading the remaining files', async () => {
    const badPath = await write('a-broken.json', '{ "version": "0.1.0", ');
    await write('b-good.json', validIdl());

    const store = await loadIdlDirectory(dir);

    expect(store.get(ADDRESS)).toBeDefined();
    expect(store.warnings).toHaveLength(1);
    expect(store.warnings[0]?.path).toBe(badPath);
    expect(store.warnings[0]?.reason).toContain('not valid JSON');
  });

  // Deleting a field from a legacy file leaves the value unresolvable from both
  // accepted positions, so the reason names both — a legacy file has no
  // `metadata.version` to fall back on, and dropping its whole `metadata` block
  // takes the address with it.
  it.each([
    ['version', '"version" or "metadata.version" is missing'],
    ['name', '"name" or "metadata.name" is missing'],
    ['instructions', '"instructions" is missing'],
    ['metadata', '"address" or "metadata.address" is missing'],
  ])('warns naming the file and both accepted positions when %s is missing', async (field, reason) => {
    const broken = validIdl();
    delete broken[field];
    const badPath = await write('broken.json', broken);
    await write('good.json', validIdl(OTHER_ADDRESS));

    const store = await loadIdlDirectory(dir);

    expect(store.programIds).toEqual([OTHER_ADDRESS]);
    expect(store.warnings).toEqual([{ kind: 'file-invalid', path: badPath, reason }]);
  });

  it('warns when the address is in neither position, since there would be nothing to index by', async () => {
    const broken = validIdl();
    broken['metadata'] = {};
    const badPath = await write('broken.json', broken);

    const store = await loadIdlDirectory(dir);

    expect(store.programIds).toEqual([]);
    expect(store.warnings).toEqual([
      {
        kind: 'file-invalid',
        path: badPath,
        reason: '"address" or "metadata.address" is missing',
      },
    ]);
  });

  it('treats a required field of the wrong type as unusable and reports what it found', async () => {
    const broken = validIdl();
    broken['instructions'] = {};
    await write('broken.json', broken);

    const store = await loadIdlDirectory(dir);

    expect(store.warnings[0]?.reason).toBe('"instructions" must be an array, found object');
  });

  it('reports the first missing field in the order Requirement 18.4 lists them', async () => {
    // Every required field absent: the reason must be stable, not whichever
    // check happened to run first.
    await write('empty.json', {});

    const store = await loadIdlDirectory(dir);

    expect(store.warnings[0]?.reason).toBe('"version" or "metadata.version" is missing');
  });

  it('ignores a second file claiming an address already loaded, naming the winner', async () => {
    const firstPath = await write('a-first.json', validIdl());
    const secondPath = await write('b-second.json', { ...validIdl(), name: 'shadow' });

    const store = await loadIdlDirectory(dir);

    expect(store.get(ADDRESS)?.path).toBe(firstPath);
    expect(store.get(ADDRESS)?.name).toBe('example_program');
    expect(store.warnings).toHaveLength(1);
    expect(store.warnings[0]?.kind).toBe('duplicate-address');
    expect(store.warnings[0]?.path).toBe(secondPath);
    expect(store.warnings[0]?.reason).toContain(firstPath);
  });
});

describe('loadIdlDirectory: determinism (Req 9.6)', () => {
  it('orders warnings by filename, not by enumeration or completion order', async () => {
    // Names chosen so creation order is the reverse of sorted order: if the
    // implementation leaned on either enumeration or read-completion order, the
    // warning sequence would come out differently.
    for (const name of ['z-bad.json', 'm-bad.json', 'a-bad.json']) {
      await write(name, 'not json');
    }

    const store = await loadIdlDirectory(dir);

    expect(store.warnings.map((w) => w.path)).toEqual([
      join(dir, 'a-bad.json'),
      join(dir, 'm-bad.json'),
      join(dir, 'z-bad.json'),
    ]);
  });

  it('produces identical stores and warnings across repeated runs', async () => {
    await write('z-bad.json', 'not json');
    await write('a-good.json', validIdl());
    await write('m-bad.json', { version: '0.1.0' });

    const first = await loadIdlDirectory(dir);
    const second = await loadIdlDirectory(dir);

    expect(second.warnings).toEqual(first.warnings);
    expect(second.programIds).toEqual(first.programIds);
    expect(second.get(ADDRESS)).toEqual(first.get(ADDRESS));
  });
});

describe('loadIdlDirectory: unreadable directory', () => {
  it('yields an empty store plus one warning naming the directory', async () => {
    const missing = join(dir, 'no', 'such', 'directory');

    const store = await loadIdlDirectory(missing);

    expect(store.programIds).toEqual([]);
    expect(store.get(ADDRESS)).toBeUndefined();
    expect(store.warnings).toHaveLength(1);
    expect(store.warnings[0]?.kind).toBe('directory-unreadable');
    expect(store.warnings[0]?.path).toBe(missing);
    expect(store.warnings[0]?.reason).toContain('ENOENT');
  });

  it('yields an empty store plus a warning when the path is a file, not a directory', async () => {
    const path = await write('example.json', validIdl());

    const store = await loadIdlDirectory(path);

    expect(store.programIds).toEqual([]);
    expect(store.warnings).toHaveLength(1);
    expect(store.warnings[0]?.kind).toBe('directory-unreadable');
  });
});
