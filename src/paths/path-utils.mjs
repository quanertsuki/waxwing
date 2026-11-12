// Lexical path comparison used by workspace ownership, managed-data checks,
// and research scratch isolation. All functions are pure; callers that need
// symlink semantics call canonicalExistingPath first.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Comparison form of a path: absolute, no trailing separator, and lowercased
 * on Windows (where path comparison is case-insensitive). This is deliberately
 * only a lexical normalisation; use canonicalExistingPath when links matter.
 * @param value - path to normalise.
 * @param platform - platform whose separator/casing rules apply.
 * @returns comparison key.
 */
export function canonicalPath(value, platform = process.platform) {
  if (typeof value !== 'string' || value === '') throw new Error('A nonempty path is required');
  let p = path.resolve(value);
  const root = path.parse(p).root;
  while (p.length > root.length && (p.endsWith(path.sep) || p.endsWith('/'))) p = p.slice(0, -1);
  return platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Comparison form of an existing path after resolving symlinks and directory
 * junctions. A missing path is an error: callers use this for workspaces and
 * managed roots that must already exist.
 * @param value - existing path.
 * @returns real comparison key.
 */
export function canonicalExistingPath(value) {
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) throw new Error(`Path does not exist: ${resolved}`);
  return canonicalPath(fs.realpathSync(resolved));
}

/** True when the path is a filesystem/drive root such as C:\ or /. */
export function isDriveRoot(value) {
  const resolved = path.resolve(value);
  return canonicalPath(resolved) === canonicalPath(path.parse(resolved).root);
}

/**
 * True when `candidate` is `ancestor` itself or is inside it. Comparison is
 * component-aware: "C:\work" is not an ancestor of "C:\workshop".
 * @param candidate - possible descendant.
 * @param ancestor - possible ancestor.
 * @returns whether candidate is equal to or below ancestor.
 */
export function sameOrDescendantPath(candidate, ancestor) {
  const c = canonicalPath(candidate), a = canonicalPath(ancestor);
  if (c === a) return true;
  const prefix = a.endsWith(path.sep) ? a : a + path.sep;
  return c.startsWith(prefix);
}

/** True when either path is equal to, an ancestor of, or a descendant of the other. */
export function pathsOverlap(a, b) {
  return sameOrDescendantPath(a, b) || sameOrDescendantPath(b, a);
}
