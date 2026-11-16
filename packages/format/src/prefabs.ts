import { PREFABS } from '@mascotte/library';
import type { Issue, MascotDocument, NodeDocument, ParamSpec, PrefabDocument } from './document.ts';

/*
 * Shape parameters and prefabs, expanded away: what is built is a plain tree of numbers.
 * Expanding never throws; problems come back as issues with the path they were found at.
 */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function join(path: string, key: string | number): string {
  return typeof key === 'number' ? `${path}[${key}]` : `${path}.${key}`;
}

/** Parameter values by name, for one scope (the document, or one prefab instance). */
type Scope = ReadonlyMap<string, number>;

/** Checks a set of parameter specs, reporting bad ones. */
function checkSpecs(specs: unknown, path: string, issues: Issue[]): Map<string, ParamSpec> {
  const out = new Map<string, ParamSpec>();
  if (specs === undefined) return out;
  if (!isObject(specs)) {
    issues.push({ path, message: 'expected an object of parameters {default, min, max}.' });
    return out;
  }
  for (const [name, spec] of Object.entries(specs)) {
    const at = join(path, name);
    if (!isObject(spec) || typeof spec.default !== 'number' || !Number.isFinite(spec.default)) {
      issues.push({
        path: at,
        message: 'expected a parameter {default, min, max} with a finite default.',
      });
      continue;
    }
    for (const key of Object.keys(spec)) {
      if (!['default', 'min', 'max', 'description'].includes(key)) {
        issues.push({
          path: join(at, key),
          message: 'unknown field (expected one of default, min, max, description).',
        });
      }
    }
    const { min, max } = spec;
    for (const [key, bound] of [
      ['min', min],
      ['max', max],
    ] as const) {
      if (bound !== undefined && (typeof bound !== 'number' || !Number.isFinite(bound))) {
        issues.push({
          path: join(at, key),
          message: `expected a finite number, got ${JSON.stringify(bound)}.`,
        });
      }
    }
    out.set(name, spec as unknown as ParamSpec);
    const problem = rangeProblem(spec.default, spec as unknown as ParamSpec);
    if (problem) issues.push({ path: join(at, 'default'), message: problem });
  }
  return out;
}

function rangeProblem(value: number, spec: ParamSpec): string | null {
  if (spec.min !== undefined && value < spec.min)
    return `expected at least ${spec.min}, got ${value}.`;
  if (spec.max !== undefined && value > spec.max)
    return `expected at most ${spec.max}, got ${value}.`;
  return null;
}

type Vector = { x: number; y: number; z: number };

function isVector(value: unknown): value is Vector {
  return (
    isObject(value) &&
    Object.keys(value).length === 3 &&
    [value.x, value.y, value.z].every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

/** The value of `{ param, times, plus }` in `scope`, or null with an issue. */
function evaluate(
  ref: Json,
  scope: Scope,
  path: string,
  issues: Issue[],
  depth = 0,
): number | Vector | null {
  for (const key of Object.keys(ref)) {
    if (!['param', 'times', 'plus'].includes(key)) {
      issues.push({
        path: join(path, key),
        message: 'unknown field (expected one of param, times, plus).',
      });
      return null;
    }
  }
  const value = typeof ref.param === 'string' ? scope.get(ref.param) : undefined;
  if (value === undefined) {
    const known = [...scope.keys()].join(', ') || 'none';
    issues.push({
      path: join(path, 'param'),
      message: `no parameter ${JSON.stringify(ref.param)} here (there are ${known}).`,
    });
    return null;
  }
  const times = ref.times ?? 1;
  if (!(typeof times === 'number' && Number.isFinite(times)) && !isVector(times)) {
    issues.push({
      path: join(path, 'times'),
      message: 'expected a finite number or a vector {x, y, z}.',
    });
    return null;
  }
  // `plus` is 0 of the same kind as `times` unless given.
  let plus: number | Vector | null = typeof times === 'number' ? 0 : { x: 0, y: 0, z: 0 };
  if (isObject(ref.plus) && 'param' in ref.plus) {
    // A chain of references, one per parameter; a few levels are plenty.
    if (depth > 8) {
      issues.push({ path: join(path, 'plus'), message: 'too many references chained in plus.' });
      return null;
    }
    plus = evaluate(ref.plus, scope, join(path, 'plus'), issues, depth + 1);
  } else if (ref.plus !== undefined) {
    plus = ref.plus as number | Vector;
    if (!(typeof plus === 'number' && Number.isFinite(plus)) && !isVector(plus)) {
      issues.push({
        path: join(path, 'plus'),
        message: 'expected a finite number, a vector {x, y, z} or a reference.',
      });
      return null;
    }
  }
  if (plus === null) return null;
  if (typeof times === 'number' && typeof plus === 'number') return value * times + plus;
  if (typeof times === 'number' || typeof plus === 'number') {
    issues.push({ path, message: 'times and plus must both be numbers or both be vectors.' });
    return null;
  }
  return { x: value * times.x + plus.x, y: value * times.y + plus.y, z: value * times.z + plus.z };
}

/** `value` with every `{ param }` reference replaced by its number in `scope`. */
function substitute(value: unknown, scope: Scope, path: string, issues: Issue[]): unknown {
  if (Array.isArray(value))
    return value.map((item, i) => substitute(item, scope, join(path, i), issues));
  if (!isObject(value)) return value;
  if ('param' in value) return evaluate(value, scope, path, issues) ?? 0;
  const out: Json = {};
  for (const [key, item] of Object.entries(value))
    out[key] = substitute(item, scope, join(path, key), issues);
  return out;
}

/** Parameter values: the specs' defaults, set again by `given` (checked against the specs). */
function valuesOf(
  specs: ReadonlyMap<string, ParamSpec>,
  given: unknown,
  outer: Scope,
  path: string,
  issues: Issue[],
): Map<string, number> {
  const values = new Map([...specs].map(([name, spec]) => [name, spec.default]));
  if (given === undefined) return values;
  if (!isObject(given)) {
    issues.push({ path, message: 'expected an object of parameter values.' });
    return values;
  }
  for (const [name, raw] of Object.entries(given)) {
    const at = join(path, name);
    const spec = specs.get(name);
    if (!spec) {
      const known = [...specs.keys()].join(', ') || 'none';
      issues.push({ path: at, message: `no parameter "${name}" (there are ${known}).` });
      continue;
    }
    const value = isObject(raw) ? evaluate(raw, outer, at, issues) : raw;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      if (value !== null)
        issues.push({
          path: at,
          message: `expected a finite number, got ${JSON.stringify(value)}.`,
        });
      continue;
    }
    const problem = rangeProblem(value, spec);
    if (problem) issues.push({ path: at, message: problem });
    else values.set(name, value);
  }
  return values;
}

/** Prefixes every set id in a prefab's subtree with the instance id. */
function prefixIds(node: Json, prefix: string): Json {
  const children = Array.isArray(node.children)
    ? node.children.map((child) => (isObject(child) ? prefixIds(child, prefix) : child))
    : node.children;
  return {
    ...node,
    ...(typeof node.id === 'string' ? { id: `${prefix}-${node.id}` } : {}),
    ...(children === undefined ? {} : { children }),
  };
}

/** Reports prefab instances inside a prefab, which are not supported. */
function findNested(node: unknown, path: string, issues: Issue[]): void {
  if (!isObject(node)) return;
  // упрощение: префаб не может содержать префабы; вернуться, если библиотеке понадобятся
  // составные части (лапа с когтями-префабами), с проверкой циклов.
  if (node.prefab !== undefined) issues.push({ path, message: 'a prefab cannot hold prefabs.' });
  if (Array.isArray(node.children)) {
    node.children.forEach((child, i) => {
      findNested(child, join(join(path, 'children'), i), issues);
    });
  }
}

interface Context {
  readonly prefabs: ReadonlyMap<string, { readonly def: PrefabDocument; readonly path: string }>;
  readonly issues: Issue[];
}

function expandNode(
  node: unknown,
  scope: Scope,
  path: string,
  context: Context,
  depth: number,
): unknown {
  // Deeper trees are refused by validation; leave them as they are.
  if (!isObject(node) || depth > 64) return node;
  const children = Array.isArray(node.children)
    ? node.children.map((child, i) =>
        expandNode(child, scope, join(join(path, 'children'), i), context, depth + 1),
      )
    : node.children;
  if (node.prefab === undefined) {
    const { children: _, ...rest } = node;
    const own = substitute(rest, scope, path, context.issues) as Json;
    return children === undefined ? own : { ...own, children };
  }
  const { issues } = context;
  const name = node.prefab;
  const found = typeof name === 'string' ? context.prefabs.get(name) : undefined;
  if (!found) {
    const known = [...context.prefabs.keys()].join(', ');
    issues.push({
      path: join(path, 'prefab'),
      message: `no prefab ${JSON.stringify(name)} (there are ${known}).`,
    });
    return { type: 'Node' };
  }
  if (node.type !== undefined)
    issues.push({ path: join(path, 'type'), message: 'a prefab instance has no type.' });
  if (typeof node.id !== 'string' || node.id === '') {
    issues.push({
      path: join(path, 'id'),
      message: 'a prefab instance needs an id, to name the ids of its nodes.',
    });
  }
  const specs = checkSpecs(found.def.params, join(found.path, 'params'), []);
  const values = valuesOf(specs, node.params, scope, join(path, 'params'), issues);
  const root = substitute(found.def.root, values, join(found.path, 'root'), issues);
  if (!isObject(root)) return { type: 'Node' };
  const prefixed = prefixIds(root, String(node.id));
  const props =
    node.props === undefined
      ? {}
      : (substitute(node.props, scope, join(path, 'props'), issues) as Json);
  const merged: Json = {
    ...prefixed,
    id: node.id,
    ...(node.name === undefined ? {} : { name: node.name }),
    props: { ...(isObject(prefixed.props) ? prefixed.props : {}), ...props },
  };
  const own = Array.isArray(prefixed.children) ? prefixed.children : [];
  const extra = Array.isArray(children) ? children : [];
  if (own.length + extra.length > 0) merged.children = [...own, ...extra];
  return merged;
}

/**
 * Expands a document's shape parameters and prefabs into a plain tree: every `{ param }` becomes
 * its number (the document's defaults, set again by `params`) and every prefab instance its
 * subtree. Returns the expanded document and the problems found; it does not throw.
 */
export function expandDocument(
  document: unknown,
  params: Readonly<Record<string, number>> = {},
): { document: unknown; issues: Issue[] } {
  const issues: Issue[] = [];
  if (!isObject(document)) return { document, issues };
  const specs = checkSpecs(document.params, 'params', issues);
  const scope = valuesOf(specs, params, new Map(), 'params (given)', issues);
  const prefabs = new Map<string, { def: PrefabDocument; path: string }>();
  for (const [name, prefab] of PREFABS) {
    prefabs.set(name, {
      def: prefab as unknown as PrefabDocument,
      path: `library prefab "${name}"`,
    });
  }
  if (document.prefabs !== undefined) {
    if (!isObject(document.prefabs)) {
      issues.push({ path: 'prefabs', message: 'expected an object of prefabs.' });
    } else {
      for (const [name, def] of Object.entries(document.prefabs)) {
        const at = join('prefabs', name);
        if (!isObject(def) || !isObject(def.root)) {
          issues.push({ path: at, message: 'expected a prefab {params, root}.' });
          continue;
        }
        for (const key of Object.keys(def)) {
          if (!['description', 'params', 'root'].includes(key)) {
            issues.push({
              path: join(at, key),
              message: 'unknown field (expected one of description, params, root).',
            });
          }
        }
        checkSpecs(def.params, join(at, 'params'), issues);
        findNested(def.root, join(at, 'root'), issues);
        prefabs.set(name, { def: def as unknown as PrefabDocument, path: at });
      }
    }
  }
  const root = expandNode(document.root, scope, 'root', { prefabs, issues }, 0);
  const { params: _, prefabs: __, ...rest } = document;
  return { document: { ...rest, root }, issues };
}

/** A node document with no prefabs or parameters left, as `expandDocument` makes it. */
export type ExpandedNode = NodeDocument & { readonly type: string };
export type ExpandedDocument = MascotDocument & { readonly root: ExpandedNode };
