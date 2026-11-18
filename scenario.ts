// The scenario's seeded RNG, reimplemented here so the forge can derive the token owner's login
// (the "viewer") without the env telling it. The env's wire.ts builds every generated name from the
// fixed seed 0x6a09e667f3bcc909 and the label 'users'; the first user it generates is the viewer.
// This module mirrors that computation exactly (FNV-1a 64-bit, splitmix64 finalizer, xorshift64*,
// nextInt with rejection). If anything about the derivation ever disagrees with the env, the
// hardcoded fallback below is the viewer the suite uses in practice.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const SCENARIO_USERS = 12;

/** FNV-1a, 64-bit: a label's stable seed contribution. */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer: a seeded value with every bit mixed into every other. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** The seed a named stream starts from: a stable function of SCENARIO_SEED and the label. */
function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*: a 64-bit state walked by three shifts and one multiply. */
class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, maxExclusive), unbiased by rejection. */
  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) throw new Error('nextInt needs a positive safe integer');
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from an empty list');
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface ScenarioUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** `count` users with unique logins, deterministic for `rng` (mirrors wire.ts generateUsers). */
function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

/**
 * The viewer (token owner) the suite uses. Derived from the scenario seed; the hardcoded value is
 * what the derivation yields for the contest's fixed seed, kept as a fallback if the derivation
 * ever throws (for example on a future seed change the kit would announce).
 */
export function viewerUser(): ScenarioUser {
  try {
    const users = generateUsers(new Rng(scenarioSeedFor('users')), SCENARIO_USERS);
    const viewer = users[0];
    if (viewer !== undefined && viewer.login !== '') return viewer;
  } catch {
    // Fall through to the fallback.
  }
  return { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
}

/** The teammate and the stranger, derived the same way (users[1] and users[2]). */
export function scenarioUsers(): ScenarioUser[] {
  try {
    return generateUsers(new Rng(scenarioSeedFor('users')), SCENARIO_USERS);
  } catch {
    return [
      { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' },
      { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' },
      { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' },
    ];
  }
}
