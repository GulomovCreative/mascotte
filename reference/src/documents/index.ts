import gloop from './gloop.json' with { type: 'json' };
import miso from './miso.json' with { type: 'json' };

/**
 * Mascots written as JSON documents by hand, for players and tests to read: Gloop, a `blob`,
 * and Miso, a `quadruped`. With Pip (a `bird`, `pipDocument`) they are the reference mascots,
 * each of another archetype, sharing the library's motions. Kept `unknown`: they are read
 * (`readDocument`, `Player`) as a page would read them.
 */
export const gloopDocument: unknown = gloop;
export const misoDocument: unknown = miso;
