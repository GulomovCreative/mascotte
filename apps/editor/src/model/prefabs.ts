import type { MascotDocument, PrefabDocument } from '@mascotte/format';
import { PREFABS } from '@mascotte/library';

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The prefab `name` as the format expands it: the document's own, unless that is no definition
 * (no root object), then the library's; `undefined` for neither.
 */
export function prefabDefinition(
  document: MascotDocument,
  name: string,
): PrefabDocument | undefined {
  const own =
    isObject(document.prefabs) && Object.hasOwn(document.prefabs, name)
      ? document.prefabs[name]
      : undefined;
  if (isObject(own) && isObject(own.root)) return own;
  // The library's prefabs are written as JSON (their root a plain record): the same shape.
  return PREFABS.get(name) as unknown as PrefabDocument | undefined;
}
