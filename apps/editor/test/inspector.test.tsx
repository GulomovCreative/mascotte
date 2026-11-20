import { type Property, propertiesOf } from '@mascotte/engine';
import { type MascotDocument, NODE_TYPES, type NodeDocument } from '@mascotte/format';
import { euler, type Quat, quat } from '@mascotte/math';
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app.tsx';
import { newDocument } from '../src/files/documents.ts';
import { setNodeField } from '../src/model/commands.ts';
import type { DocPath } from '../src/model/paths.ts';
import { nodeAt } from '../src/model/paths.ts';
import { editor, offeredDraft, openDocument, problem, state } from '../src/store.ts';

let host: HTMLDivElement | null = null;

afterEach(() => {
  if (host) {
    render(null, host);
    host.remove();
    host = null;
  }
  offeredDraft.value = null;
  openDocument(newDocument('blob'), null);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A blob document with the parameters `unit` (1), `size` (10) and `extra` (2), a palette, and
 * `node` under its root.
 */
function documentWith(node: NodeDocument, base = newDocument('blob')): MascotDocument {
  return {
    ...base,
    params: { unit: { default: 1 }, size: { default: 10 }, extra: { default: 2 } },
    palettes: { base: { body: '#f6c24c', eyes: '#222222' } },
    root: { ...base.root, children: [...(base.root.children ?? []), node] },
  };
}

/** Opens `document` and selects its root's last child; returns its path. */
async function inspect(node: NodeDocument, document = documentWith(node)): Promise<DocPath> {
  openDocument(document, null);
  host = window.document.createElement('div');
  window.document.body.append(host);
  render(<App />, host);
  const path = [(document.root.children?.length ?? 1) - 1];
  editor.value.select(path);
  await settle();
  return path;
}

function control<T extends HTMLElement = HTMLInputElement>(label: string): T {
  const found = document.querySelector<T>(`form[aria-label="Node"] [aria-label="${label}"]`);
  if (!found) throw new Error(`no control ${label}`);
  return found;
}

/** Types `value` into the control `label` and commits it, as leaving the field does. */
async function change(label: string, value: string): Promise<void> {
  const field = control<HTMLInputElement | HTMLSelectElement>(label);
  field.value = value;
  field.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
}

async function click(label: string): Promise<void> {
  control(label).click();
  await settle();
}

const props = (path: DocPath) => nodeAt(state.value.document, path)?.props ?? {};
const pathOf = (path: DocPath) => nodeAt(state.value.document, path)?.path;
const valid = () => expect(state.value.issues).toEqual([]);

/** The quaternion of Euler angles in degrees (XYZ). */
function turned(x: number, y: number, z: number) {
  const radians = Math.PI / 180;
  return quat.fromEuler(quat.create(), euler.create(x * radians, y * radians, z * radians));
}

describe('inspector', () => {
  for (const [typeName, type] of NODE_TYPES) {
    it(`edits and binds every property of a ${typeName}, keeping it valid`, async () => {
      const path = await inspect({ type: typeName, id: 'it' });
      const palette = Object.keys(Object.values(state.value.document.palettes ?? {})[0] ?? {});
      for (const property of propertiesOf(type)) {
        const name = property.name;
        switch (property.type) {
          case 'number': {
            // A value its range allows: 2, or the nearest allowed.
            const { min, max, exclusiveMin } = property;
            const low = min === undefined ? -Infinity : exclusiveMin ? min + 1 : min;
            const value = Math.min(max ?? Infinity, Math.max(low, 2));
            await change(name, String(value));
            expect(props(path)[name], name).toBe(value);
            valid();
            await change(`${name} source`, 'param');
            expect(props(path)[name], name).toEqual({ param: 'unit' });
            await change(`${name} times`, String(value));
            valid();
            await change(`${name} source`, 'value');
            expect(props(path)[name], name).toBe(value);
            break;
          }
          case 'vec3': {
            await change(`${name} y`, '3');
            expect(props(path)[name], name).toEqual({ ...property.default, y: 3 });
            await change(`${name} source`, 'param');
            expect(props(path)[name], name).toEqual({
              param: 'unit',
              times: { x: 1, y: 1, z: 1 },
            });
            await change(`${name} times y`, '2');
            valid();
            await change(`${name} source`, 'value');
            expect(props(path)[name], name).toEqual({ x: 1, y: 2, z: 1 });
            break;
          }
          case 'quat': {
            await change(`${name} x`, '30');
            await change(`${name} z`, '45');
            const q = props(path)[name] as unknown as Record<string, number>;
            const want = turned(30, 0, 45);
            for (const key of ['x', 'y', 'z', 'w']) {
              expect(q[key], key).toBeCloseTo(want[key as keyof typeof want]);
            }
            expect(['x', 'y', 'z'].map((axis) => control(`${name} ${axis}`).value)).toEqual([
              '30',
              '0',
              '45',
            ]);
            // An emptied angle is no change.
            await change(`${name} y`, '');
            expect(props(path)[name]).toBe(q);
            expect(control(`${name} y`).value).toBe('0');
            break;
          }
          case 'color': {
            await change(name, '#123456');
            expect(props(path)[name], name).toBe('#123456');
            await change(`${name} source`, 'palette');
            expect(props(path)[name], name).toEqual({ color: palette[0] });
            await change(`${name} role`, palette.at(-1) as string);
            expect(props(path)[name], name).toEqual({ color: palette.at(-1) });
            valid();
            await change(`${name} source`, 'value');
            expect(props(path)[name], name).toBe('#222222');
            break;
          }
          case 'bool':
            await click(name);
            expect(props(path)[name], name).toBe(!property.default);
            break;
          case 'enum': {
            const value = property.values.find((each) => each !== property.default) as string;
            await change(name, value);
            expect(props(path)[name], name).toBe(value);
            break;
          }
          default:
            throw new Error(`no test for a property of type ${(property as Property).type}`);
        }
        valid();
        await click(`Reset ${name}`);
        expect(props(path)[name], name).toBeUndefined();
      }
    });
  }

  it('chains a reference to several parameters, unbinds it, and undoes each edit', async () => {
    const path = await inspect({ type: 'Sphere', id: 'it' });
    await change('diameter source', 'param');
    await change('diameter parameter', 'size');
    await change('diameter times', '2');
    await change('diameter plus source', 'param');
    await change('diameter plus parameter', 'extra');
    await change('diameter plus times', '4');
    const chained = { param: 'size', times: 2, plus: { param: 'extra', times: 4 } };
    expect(props(path).diameter).toEqual(chained);
    valid();
    // What the inner reference adds stays added.
    await change('diameter plus source', 'value');
    expect(props(path).diameter).toEqual({ param: 'size', times: 2, plus: 8 });
    await change('diameter plus', '5');
    expect(props(path).diameter).toEqual({ param: 'size', times: 2, plus: 5 });
    editor.value.undo();
    editor.value.undo();
    expect(props(path).diameter).toEqual(chained);
    await settle();
    await change('diameter source', 'value');
    expect(props(path).diameter).toBe(28);
  });

  it('adds a parameter to a vector reference, and unbinds it to the sum', async () => {
    const path = await inspect({ type: 'Node', id: 'it' });
    await change('position source', 'param');
    await change('position plus source', 'param');
    await change('position plus parameter', 'size');
    await change('position plus times x', '3');
    expect(props(path).position).toEqual({
      param: 'unit',
      times: { x: 1, y: 1, z: 1 },
      plus: { param: 'size', times: { x: 3, y: 1, z: 1 } },
    });
    valid();
    await change('position source', 'value');
    expect(props(path).position).toEqual({ x: 31, y: 11, z: 11 });
  });

  it('keeps a binding it cannot unbind, and says why', async () => {
    const path = await inspect({
      type: 'Sphere',
      id: 'it',
      props: { diameter: { param: 'gone' }, 'style.color': { color: 'gone' } },
    });
    await change('diameter source', 'value');
    expect(props(path).diameter).toEqual({ param: 'gone' });
    expect(problem.value).toMatch(/unbind diameter/);
    expect(control<HTMLSelectElement>('diameter source').value).toBe('param');
    await change('style.color source', 'value');
    expect(props(path)['style.color']).toEqual({ color: 'gone' });
    expect(problem.value).toMatch(/no palette has the role "gone"/);
    expect(control<HTMLSelectElement>('style.color source').value).toBe('palette');
    // The missing parameter and role stay shown.
    expect(control<HTMLSelectElement>('diameter parameter').value).toBe('gone');
    expect(control<HTMLSelectElement>('style.color role').value).toBe('gone');
    problem.value = null;
  });

  it('binds a plus to a parameter, keeping what it added', async () => {
    const path = await inspect({
      type: 'Sphere',
      id: 'it',
      props: { diameter: { param: 'unit', plus: 5 } },
    });
    await change('diameter plus source', 'param');
    expect(props(path).diameter).toEqual({ param: 'unit', plus: { param: 'unit', plus: 5 } });
    valid();
  });

  it('offers no binding without parameters or palettes', async () => {
    const base = newDocument('blob');
    const node = { type: 'Sphere', id: 'it' };
    await inspect(node, { ...base, root: { ...base.root, children: [node] } });
    const option = (label: string, value: string) =>
      [...control<HTMLSelectElement>(label).options].find((each) => each.value === value);
    expect(option('diameter source', 'param')?.disabled).toBe(true);
    expect(option('style.color source', 'palette')?.disabled).toBe(true);
  });

  it('marks a value the format refuses and lists the issue', async () => {
    const path = await inspect({ type: 'Sphere', id: 'it' });
    await change('opacity', '3');
    expect(props(path).opacity).toBe(3);
    expect(document.querySelector('.prop.invalid .prop-name')?.textContent).toBe('opacity');
    expect(document.querySelector('form[aria-label="Node"] [role="alert"]')?.textContent).toMatch(
      /props\.opacity/,
    );
    await change('opacity', '');
    expect(props(path).opacity).toBeUndefined();
    expect(document.querySelector('.prop.invalid')).toBeNull();
  });

  it("edits a path's points, binds one, and changes a command's type", async () => {
    const path = await inspect({ type: 'PathShape', id: 'it' });
    await click('Add point');
    await change('Path 1 point x', '4');
    await click('Add point');
    await change('Path 2 point y', '6');
    expect(pathOf(path)).toEqual([
      { type: 'move', point: { x: 4 } },
      { type: 'line', point: { x: 4, y: 6 } },
    ]);
    await change('Path 2 type', 'bezier');
    await change('Path 2 control1 source', 'param');
    expect(pathOf(path)?.[1]).toEqual({
      type: 'bezier',
      control1: { param: 'unit', times: { x: 1, y: 1, z: 1 } },
      control2: { x: 4, y: 6 },
      point: { x: 4, y: 6 },
    });
    valid();
    // A point bound last: the next starts at no point in particular.
    await change('Path 2 point source', 'param');
    await click('Add point');
    expect(pathOf(path)?.[2]).toEqual({ type: 'line', point: {} });
    await click('Remove Path 3');
    await change('Path 2 point source', 'value');
    await change('Path 2 type', 'arc');
    expect(pathOf(path)?.[1]).toEqual({
      type: 'arc',
      corner: { x: 1, y: 1, z: 1 },
      point: { x: 1, y: 1, z: 1 },
    });
    await change('Path 2 type', 'line');
    expect(pathOf(path)?.[1]).toEqual({ type: 'line', point: { x: 1, y: 1, z: 1 } });
    valid();
    await change('Path 2 point x', '');
    expect(pathOf(path)?.[1]).toEqual({ type: 'line', point: { y: 1, z: 1 } });
    await click('Remove Path 1');
    await click('Remove Path 1');
    expect(pathOf(path)).toBeUndefined();
  });

  it('shows a malformed path, and a rotation that is no rotation, without breaking', async () => {
    const path = await inspect({
      type: 'PathShape',
      id: 'it',
      path: [null, { type: 'constructor' }, 'line'],
      props: { rotation: { x: 0, y: 0, z: 0 } },
    } as unknown as NodeDocument);
    expect(state.value.issues.length).toBeGreaterThan(0);
    expect(document.querySelector('form[aria-label="Node"]')?.textContent).toMatch(
      /Path 1 is not a command/,
    );
    expect(control<HTMLSelectElement>('Path 2 type').value).toBe('constructor');
    expect(control('rotation x').value).toBe('');
    await change('rotation z', '90');
    const q = props(path).rotation as unknown as Quat;
    expect(q.z).toBeCloseTo(Math.SQRT1_2);
    expect(q.w).toBeCloseTo(Math.SQRT1_2);
    await click('Remove Path 1');
    await click('Remove Path 2');
    await change('Path 1 type', 'move');
    expect(pathOf(path)).toEqual([{ type: 'move', point: {} }]);
    editor.value.execute(setNodeField(path, 'path', 'oops' as unknown as NodeDocument['path']));
    await settle();
    await click('Remove the path');
    expect(pathOf(path)).toBeUndefined();
  });

  it("hides a box's face and colors one from the palette", async () => {
    const path = await inspect({ type: 'Box', id: 'it' });
    await click('front face visible');
    await change('top face color source', 'palette');
    expect(nodeAt(state.value.document, path)?.faces).toEqual({
      front: { visible: false },
      top: { color: { color: 'body' } },
    });
    await click('Reset front face');
    await change('top face color source', 'value');
    expect(nodeAt(state.value.document, path)?.faces).toEqual({ top: { color: '#f6c24c' } });
    valid();
  });

  it("shows an instance's values from its prefab's root, not its path", async () => {
    const path = await inspect({ prefab: 'mouth', id: 'it' });
    expect(document.querySelector('form[aria-label="Node"] legend')?.textContent).toMatch(
      /^mouth \(PathShape\)/,
    );
    // The mouth's root is open, though a PathShape is closed by default.
    expect(control('closed').checked).toBe(false);
    expect(control('style.color').placeholder).toBe('#5a2a0c');
    const legends = [...document.querySelectorAll('form[aria-label="Node"] legend')];
    expect(legends.map((legend) => legend.textContent)).not.toContain('Path');
    await click('closed');
    expect(props(path).closed).toBe(true);
  });

  it('says why a node has no properties to show', async () => {
    await inspect({ prefab: 'nothing', id: 'it' });
    expect(document.querySelector('form[aria-label="Node"]')?.textContent).toMatch(
      /No prefab "nothing"/,
    );
  });

  it('shows nodes of malformed prefabs, palettes and props without breaking', async () => {
    const node = { prefab: 'eye', id: 'it' };
    const document = {
      ...documentWith(node),
      // Not a definition: the library's eye stands, as when the format expands it.
      prefabs: { eye: {}, broken: { root: 5 } },
      palettes: { base: null },
    } as unknown as MascotDocument;
    const path = await inspect(node, document);
    expect(window.document.querySelector('form[aria-label="Node"] legend')?.textContent).toMatch(
      /^eye \(Node\)/,
    );
    // Props that are no object are replaced by the first edit.
    const odd = { ...nodeAt(state.value.document, path), props: 'abc' } as unknown as NodeDocument;
    openDocument(
      {
        ...document,
        root: { ...document.root, children: [...(document.root.children ?? []).slice(0, -1), odd] },
      },
      null,
    );
    editor.value.select(path);
    await settle();
    await change('position x', '2');
    expect(props(path)).toEqual({ position: { x: 2, y: 0, z: 0 } });
  });

  it("shows an instance's properties by its prefab's root, and names a node", async () => {
    const path = await inspect({ prefab: 'eye', id: 'it' });
    expect(document.querySelector('form[aria-label="Node"] legend')?.textContent).toMatch(
      /^eye \(Node\)/,
    );
    await change('position x', '7');
    expect(props(path).position).toEqual({ x: 7, y: 0, z: 0 });
    const name = document.querySelector<HTMLInputElement>('form[aria-label="Node"] label input');
    if (!name) throw new Error('no name field');
    name.value = 'Left eye';
    name.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(nodeAt(state.value.document, path)?.name).toBe('Left eye');
  });
});
