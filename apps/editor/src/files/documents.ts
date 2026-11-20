import {
  DocumentError,
  FORMAT,
  type MascotDocument,
  migrate,
  type NodeDocument,
  readDocument,
  VERSION,
} from '@mascotte/format';
import { ARCHETYPES } from '@mascotte/library';
import { gloopDocument, misoDocument, pipDocument } from '@mascotte/reference';

/** The text a document is saved as: JSON, two-space indented, a newline at the end. */
export function documentText(document: MascotDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Reads a document from a file's text: parsed and migrated to the current version, but not
 * validated, so a document saved (or kept as a draft) with issues opens again and the editor
 * shows them. Throws a `DocumentError` for text that is not JSON, not a mascot document, or has
 * no root node to edit.
 */
export function readDocumentText(text: string): MascotDocument {
  // упрощение: документ с ошибками доходит до модели редактора как есть; дерево (#90) его
  // показывает (не-узлы среди детей пропускает), но команды идут через `nodeAt` и `expandedIds`,
  // не устойчивые к неверной форме (ошибку ловит `attempt`). К инспектору (#91) запускать команды
  // только на прошедших проверку документах или сделать эти обходы устойчивыми.
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const message = `not JSON: ${(error as Error).message}`;
    throw new DocumentError([{ path: '', message }], { cause: error });
  }
  const document = migrate(value);
  const root = document.root;
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new DocumentError([{ path: 'root', message: 'expected a node.' }]);
  }
  return document as unknown as MascotDocument;
}

/** The reference mascots the editor opens from its menu, by name. */
export const REFERENCE_DOCUMENTS: ReadonlyMap<string, () => MascotDocument> = new Map([
  ['Pip', () => readDocument(pipDocument())],
  ['Gloop', () => readDocument(gloopDocument)],
  ['Miso', () => readDocument(misoDocument)],
]);

const BODY = '#f6c34a';
const INK = '#2b1d0e';

/** A node bound to a slot that holds nothing yet: an empty node with its id. */
function slot(id: string, props: NodeDocument['props'] = {}, children: NodeDocument[] = []) {
  return {
    type: 'Node',
    id,
    ...(Object.keys(props ?? {}).length > 0 ? { props } : {}),
    ...(children.length > 0 ? { children } : {}),
  } satisfies NodeDocument;
}

/** The eyes and closed lids, on a face `z` in front of its center. */
function face(z: number): NodeDocument[] {
  const eye = (side: number) => ({
    prefab: 'eye',
    id: side < 0 ? 'eye-left' : 'eye-right',
    props: { position: { x: side * 10, y: 0, z } },
  });
  const lid = (side: number) => ({
    type: 'PathShape',
    props: { closed: false, 'style.stroke': 2, 'style.color': INK },
    path: [
      { type: 'move' as const, point: { x: side * 10 - 6, y: 0, z: z + 2 } },
      { type: 'line' as const, point: { x: side * 10 + 6, y: 0, z: z + 2 } },
    ],
  });
  return [
    slot('eyes', { position: { x: 0, y: -4, z: 0 } }, [eye(-1), eye(1)]),
    slot('lids', { position: { x: 0, y: -4, z: 0 }, visible: false }, [lid(-1), lid(1)]),
  ];
}

/**
 * A new document of `archetype`: a node for each slot it requires (`root`, `body`, `eyes`,
 * `lids` and the archetype's own), bound in the rig, with a body to see, eyes and lids, so the
 * document is valid and shows something from the start.
 */
export function newDocument(archetype: string): MascotDocument {
  const spec = ARCHETYPES.get(archetype);
  if (!spec) throw new RangeError(`No archetype "${archetype}".`);
  const sphere = (id: string, diameter: number, position: { x: number; y: number; z: number }) => ({
    type: 'Sphere',
    id,
    props: { diameter, position, 'style.color': BODY, 'style.stroke': 0 },
  });
  const slots: Record<string, string> = { root: 'root', body: 'body', eyes: 'eyes', lids: 'lids' };
  const own = spec.slots.filter((name) => !(name in slots));
  // A head where the archetype has one: the face goes on it, otherwise on the body.
  const hasHead = own.includes('head');
  const extras: NodeDocument[] = [];
  for (const name of own) {
    if (name === 'head') continue;
    const id = name.replace('.', '-').toLowerCase();
    slots[name] = id;
    const side = name.endsWith('.L') ? -1 : 1;
    extras.push(slot(id, { position: { x: side * 30, y: -20, z: 0 } }));
  }
  if (hasHead) slots.head = 'head';
  const front = hasHead
    ? [{ ...sphere('head', 40, { x: 0, y: -50, z: 0 }), children: face(18) }]
    : face(30);
  const body = { ...sphere('body', 60, { x: 0, y: -30, z: 0 }), children: [...front, ...extras] };
  return {
    format: FORMAT,
    version: VERSION,
    meta: { name: 'Untitled' },
    archetype,
    view: { width: 240, height: 240, background: '#eef1f6' },
    camera: { props: { zoom: 1.4 } },
    root: {
      type: 'Node',
      id: 'root',
      props: { position: { x: 0, y: 50, z: 0 } },
      children: [body],
    },
    rig: { slots },
  };
}
