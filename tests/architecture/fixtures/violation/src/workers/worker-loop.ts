/**
 * Fixture stub — fake concrete infrastructure module. Exists only so
 * the violating domain import resolves. NOT real worker logic.
 */

export function createInMemoryJobQueue(): unknown {
  return { _fixture: true };
}
