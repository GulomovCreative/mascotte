import { propertiesOf } from '@mascotte/engine';
import { type MascotDocument, NODE_TYPES, type NodeDocument } from '@mascotte/format';
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app.tsx';
import { newDocument } from '../src/files/documents.ts';
import type { DocPath } from '../src/model/paths.ts';
import { nodeAt } from '../src/model/paths.ts';
import { editor, offeredDraft, openDocument, state } from '../src/store.ts';

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
 * A new blob document with the parameters `size` (10) and `extra` (2), a palette, and `node`
 * under its root.
 */
function documentWith(node: NodeDocument): MascotDocument {
  const base = newDocument('blob');
  return {
    ...base,
    params: { size: { default: 10 }, extra: { default: 2 } },
    palettes: { base: { body: '#f6c24c', eyes: '#222222' } },
    root: { ...base.root, children: [...(base.root.children ?? []), node] },
  };
}

/** Opens `node` in a document and selects it; returns its path. */
async function inspect(node: NodeDocument): Promise<DocPath> {
  const document = documentWith(node);
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

describe('inspector', () => {
  for (const [typeName, type] of NODE_TYPES) {
    it(`edits and binds every property of a ${typeName}`, async () => {
      const path = await inspect({ type: typeName, id: 'it' });
      const palette = Object.keys(Object.values(state.value.document.palettes ?? {})[0] ?? {});
      expect(palette.length).toBeGreaterThan(0);
      for (const property of propertiesOf(type)) {
        const name = property.name;
        switch (property.type) {
          case 'number': {
            const value = property.max !== undefined && property.max < 2 ? property.max : 2;
            await change(name, String(value));
            expect(props(path)[name], name).toBe(value);
            await change(`${name} source`, 'param');
            expect(props(path)[name], name).toEqual({ param: 'size' });
            await change(`${name} times`, '3');
            await change(`${name} source`, 'value');
            expect(props(path)[name], name).toBe(30);
            break;
          }
          case 'vec3': {
            await change(`${name} y`, '3');
            expect(props(path)[name], name).toEqual({ ...property.default, y: 3 });
            await change(`${name} source`, 'param');
            expect(props(path)[name], name).toEqual({
              param: 'size',
              times: { x: 1, y: 1, z: 1 },
            });
            await change(`${name} times y`, '2');
            await change(`${name} source`, 'value');
            expect(props(path)[name], name).toEqual({ x: 10, y: 20, z: 10 });
            break;
          }
          case 'quat': {
            await change(`${name} y`, '90');
            const q = props(path)[name] as unknown as Record<string, number>;
            expect(q.y).toBeCloseTo(Math.SQRT1_2);
            expect(q.w).toBeCloseTo(Math.SQRT1_2);
            expect(control(`${name} y`).value).toBe('90');
            break;
          }
          case 'color': {
            await change(name, '#123456');
            expect(props(path)[name], name).toBe('#123456');
            await change(`${name} source`, 'palette');
            expect(props(path)[name], name).toEqual({ color: palette[0] });
            await change(`${name} role`, palette.at(-1) as string);
            expect(props(path)[name], name).toEqual({ color: palette.at(-1) });
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
        }
        await click(`Reset ${name}`);
        expect(props(path)[name], name).toBeUndefined();
      }
    });
  }

  it('chains a reference to several parameters, and undoes each edit as a step', async () => {
    const path = await inspect({ type: 'Sphere', id: 'it' });
    await change('diameter source', 'param');
    await change('diameter times', '2');
    await change('diameter plus source', 'param');
    await change('diameter plus parameter', 'extra');
    await change('diameter plus times', '4');
    expect(props(path).diameter).toEqual({
      param: 'size',
      times: 2,
      plus: { param: 'extra', times: 4 },
    });
    expect(state.value.issues).toEqual([]);
    await change('diameter plus source', 'value');
    await change('diameter plus', '5');
    expect(props(path).diameter).toEqual({ param: 'size', times: 2, plus: 5 });
    editor.value.undo();
    editor.value.undo();
    expect(props(path).diameter).toEqual({
      param: 'size',
      times: 2,
      plus: { param: 'extra', times: 4 },
    });
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
    expect(nodeAt(state.value.document, path)?.path).toEqual([
      { type: 'move', point: { x: 4 } },
      { type: 'line', point: { x: 4, y: 6 } },
    ]);
    await change('Path 2 type', 'bezier');
    await change('Path 2 control1 source', 'param');
    expect(nodeAt(state.value.document, path)?.path?.[1]).toEqual({
      type: 'bezier',
      control1: { param: 'size', times: { x: 1, y: 1, z: 1 } },
      control2: { x: 4, y: 6 },
      point: { x: 4, y: 6 },
    });
    expect(state.value.issues).toEqual([]);
    await change('Path 2 point x', '');
    expect(nodeAt(state.value.document, path)?.path?.[1]).toMatchObject({ point: { y: 6 } });
    await click('Remove Path 1');
    await click('Remove Path 1');
    expect(nodeAt(state.value.document, path)?.path).toBeUndefined();
  });

  it("hides a box's face and colors one from the palette", async () => {
    const path = await inspect({ type: 'Box', id: 'it' });
    const face = document.querySelector<HTMLInputElement>('.form-panel label.check input');
    face?.click();
    await settle();
    const role = Object.keys(Object.values(state.value.document.palettes ?? {})[0] ?? {})[0];
    await change('top face color source', 'palette');
    expect(nodeAt(state.value.document, path)?.faces).toEqual({
      front: { visible: false },
      top: { color: { color: role } },
    });
    await click('Reset front face');
    await change('top face color source', 'value');
    expect(nodeAt(state.value.document, path)?.faces?.top?.color).toBe('#f6c24c');
    expect(state.value.issues).toEqual([]);
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
