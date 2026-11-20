import {
  Camera,
  CanvasRenderer,
  CLICK_DISTANCE,
  type Viewport as Frame,
  HitTester,
  type Node,
  Scene,
  WebGLRenderer,
} from '@mascotte/engine';
import { type Mat3x4, mat3x4 } from '@mascotte/math';
import { effect, signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { setProp } from '../model/commands.ts';
import type { EditorDocument } from '../model/editor-document.ts';
import { nodeAt, samePath } from '../model/paths.ts';
import { attempt, editor, problem, state } from '../store.ts';
import {
  dragged,
  drawGizmo,
  type GizmoFrame,
  type GizmoMode,
  type GizmoSpace,
  gizmoFrame,
  type Handle,
  handleAt,
  type Transform,
  transformOf,
} from './gizmo.ts';
import { applyOrbit, type Orbit, orbitFrom, pan, turn, zoom } from './orbit.ts';
import { type DebugView, drawOverlay } from './overlay.ts';

/** Draws `scene` from `camera` in `frame`, anew. */
type Draw = (scene: Scene, camera: Camera, frame: Frame) => void;

/** Which camera the viewport looks through: its own orbit, or the document's within its frame. */
export const viewCamera = signal<'orbit' | 'document'>('orbit');
/**
 * The orbit, or `null` until the first turn, pan or zoom; meanwhile the viewport starts it,
 * unturned, from the document's camera as it is now.
 */
export const orbit = signal<Orbit | null>(null);
// Another document opened: the orbit starts again from its camera.
effect(() => {
  void editor.value;
  orbit.value = null;
});

/** What the gizmo changes: move, rotate or scale. */
export const gizmoMode = signal<GizmoMode>('move');
/** The axes it moves and turns along (scale always goes along the node's own). */
export const gizmoSpace = signal<GizmoSpace>('local');
/** Whether a drag snaps; holding Ctrl snaps it too. */
export const snapping = signal(false);

/** What the debug view shows. */
export const debugView = signal<DebugView>({
  axes: true,
  bones: false,
  sort: false,
  anchors: false,
  frame: true,
});

/**
 * A renderer for the canvas: WebGL2, or Canvas 2D where the browser has no WebGL2. A canvas that
 * gives a WebGL2 context cannot give a 2D one afterwards, so a WebGL renderer that fails to start
 * there is an error, not a fallback.
 */
function rendererFor(canvas: HTMLCanvasElement): {
  draw: Draw;
  /** Whether the GPU context is lost: frames are skipped until the browser gives it back. */
  lost: () => boolean;
  destroy: () => void;
} {
  const probe = document.createElement('canvas').getContext('webgl2');
  if (probe) {
    probe.getExtension('WEBGL_lose_context')?.loseContext();
    let gl: WebGLRenderer;
    try {
      gl = new WebGLRenderer(canvas);
    } catch (error) {
      throw new Error('The viewport could not start WebGL2.', { cause: error });
    }
    return {
      draw: (scene, camera, frame) => {
        // Drawn on every call, as `Draw` promises: the renderer would skip a frame it takes for
        // unchanged.
        gl.invalidate();
        gl.render(scene, camera, frame);
      },
      lost: () => gl.contextLost,
      destroy: () => gl.destroy(),
    };
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('The viewport has neither WebGL2 nor a 2D context.');
  const canvas2d = new CanvasRenderer();
  return {
    draw: (scene, camera, frame) => canvas2d.render(ctx, scene, camera, frame),
    lost: () => false,
    destroy: () => {},
  };
}

/**
 * The built node of the selected document node: the first the source map gives its path. None
 * while the scene is stale: its paths are an older document's.
 */
function selectedNode(): Node | null {
  const { scene, selection, stale } = state.value;
  if (!scene || !selection || stale) return null;
  for (const [node, path] of scene.sources) if (samePath(path, selection)) return node;
  return null;
}

/**
 * The transform of the selected document node, what it leaves out taken from its built `node`,
 * or `null` with nothing selected or when a part of it is a reference the gizmo cannot change.
 */
function selectedTransform(node: Node | null): Transform | null {
  const { document, selection } = state.peek();
  const source = selection && nodeAt(document, selection);
  return node && source ? transformOf(source.props ?? {}, node) : null;
}

/** A few buttons, one pressed: the one whose option `value` holds. */
function Choice<T extends string>(props: {
  legend: string;
  value: { value: T };
  options: readonly (readonly [T, string])[];
}) {
  return (
    <fieldset class="segmented">
      <legend class="visually-hidden">{props.legend}</legend>
      {props.options.map(([option, label]) => (
        <button
          key={option}
          type="button"
          aria-pressed={props.value.value === option}
          onClick={() => {
            props.value.value = option;
          }}
        >
          {label}
        </button>
      ))}
    </fieldset>
  );
}

/** A toggle of the debug view. */
function DebugToggle(props: { name: keyof DebugView; label: string }) {
  return (
    <label>
      <input
        type="checkbox"
        checked={debugView.value[props.name]}
        onChange={(event) => {
          debugView.value = {
            ...debugView.value,
            [props.name]: (event.currentTarget as HTMLInputElement).checked,
          };
        }}
      />
      {props.label}
    </label>
  );
}

/**
 * The palette the viewport shows the document in (the base by default), without changing the
 * document; only when it has more than one.
 */
function PaletteSwitcher() {
  const { document, preview } = state.value;
  const palettes = Object.keys(document.palettes ?? {});
  if (palettes.length < 2) return null;
  return (
    <label>
      Palette
      <select
        value={preview.palette ?? palettes[0]}
        onChange={(event) => {
          const palette = (event.currentTarget as HTMLSelectElement).value;
          const { palette: _, ...rest } = preview;
          // The base is no preview: it is what the document shows anyway.
          attempt('Could not preview it', () =>
            editor.value.setPreview(palette === palettes[0] ? rest : { ...rest, palette }),
          );
        }}
      >
        {palettes.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The viewport's bar: the camera to look through, the palette, and the debug view's toggles. */
function ViewportBar() {
  return (
    <div class="viewport-bar">
      <Choice
        legend="Camera"
        value={viewCamera}
        options={[
          ['orbit', 'Orbit'],
          ['document', 'Document camera'],
        ]}
      />
      <Choice
        legend="Gizmo"
        value={gizmoMode}
        options={[
          ['move', 'Move'],
          ['rotate', 'Rotate'],
          ['scale', 'Scale'],
        ]}
      />
      <Choice
        legend="Gizmo axes"
        value={gizmoSpace}
        options={[
          ['local', 'Local'],
          ['world', 'World'],
        ]}
      />
      <label>
        <input
          type="checkbox"
          checked={snapping.value}
          onChange={(event) => {
            snapping.value = (event.currentTarget as HTMLInputElement).checked;
          }}
        />
        Snap
      </label>
      <PaletteSwitcher />
      <fieldset class="debug-toggles">
        <legend class="visually-hidden">Debug view</legend>
        <DebugToggle name="axes" label="Axes" />
        <DebugToggle name="bones" label="Bones" />
        <DebugToggle name="sort" label="Sort order" />
        <DebugToggle name="anchors" label="Decal anchors" />
        <DebugToggle name="frame" label="Frame" />
      </fieldset>
    </div>
  );
}

/**
 * The viewport: the open document's scene (the last that built), drawn by the engine through the
 * viewport's orbit camera (drag to turn, shift-drag or the middle button to pan, the wheel to
 * zoom) or the document's camera fitted to its frame; a primary click selects the document node
 * under the pointer (not while the scene is stale); the debug view is drawn on an overlay.
 * Redrawn when the editor's state (document, selection), the camera, the debug view, the panel's
 * size or the pixel ratio changes. What goes wrong is shown in the menu bar.
 */
export function Viewport() {
  const ref = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const overlayCanvas = overlayRef.current;
    if (!canvas || !overlayCanvas) return;
    // What this viewport reported last: it clears only its own message, and sets one once (a
    // message dismissed stays dismissed while the same thing goes wrong).
    let reported: string | null = null;
    const report = (message: string | null) => {
      if (message === reported) return;
      if (message !== null) problem.value = message;
      else if (problem.peek() === reported) problem.value = null;
      reported = message;
    };
    const failed = (what: string, error: unknown) => {
      console.error(error);
      report(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    };
    let overlay: CanvasRenderingContext2D;
    let renderer: ReturnType<typeof rendererFor>;
    try {
      const context = overlayCanvas.getContext('2d');
      if (!context) throw new Error('its overlay has no 2D context.');
      overlay = context;
      renderer = rendererFor(canvas);
    } catch (error) {
      failed('Could not start the viewport', error);
      return;
    }
    const hits = new HitTester();
    const empty = new Scene();
    const fallback = new Camera();
    const own = new Camera();
    // What the last frame was drawn with, for picking and panning: its camera, its size in its
    // own units, and how many CSS pixels a unit is.
    let drawn = { camera: fallback, width: 1, height: 1, scale: 1 };

    // A frame that fails to draw is reported, not thrown: the effect that draws it runs inside
    // whatever changed the state, the store's own updates included.
    const fit = () => {
      try {
        draw();
        report(
          renderer.lost()
            ? 'The viewport lost its GPU context: it draws again when the browser gives it back.'
            : null,
        );
      } catch (error) {
        failed('Could not draw the viewport', error);
      }
    };
    // The orbit as it is, or as it starts from the document's camera; none without a scene.
    const currentOrbit = (): Orbit | null => {
      const built = state.peek().scene;
      return orbit.peek() ?? (built ? orbitFrom(built.built.camera) : null);
    };
    const draw = () => {
      // Read first, so the effect keeps watching them even when this frame draws nothing.
      void [
        state.value,
        viewCamera.value,
        orbit.value,
        debugView.value,
        gizmoMode.value,
        gizmoSpace.value,
      ];
      // No handle to take until a gizmo is drawn again.
      gizmo = null;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      // Not laid out (or gone): nothing to draw on.
      if (!(width > 0 && height > 0)) return;
      const ratio = devicePixelRatio || 1;
      const pixelWidth = Math.max(1, Math.round(width * ratio));
      const pixelHeight = Math.max(1, Math.round(height * ratio));
      // Sized only when the size changes: sizing clears and reallocates the canvas.
      for (const target of [canvas, overlayCanvas]) {
        if (target.width !== pixelWidth) target.width = pixelWidth;
        if (target.height !== pixelHeight) target.height = pixelHeight;
      }
      const built = state.value.scene;
      const documentCamera = built?.built.camera ?? fallback;
      // The built scene's view: validated, unlike the document while it has issues.
      const view = built?.built.view;
      let camera = documentCamera;
      let scale = 1;
      if (viewCamera.value === 'orbit') {
        const current = currentOrbit();
        if (current) {
          applyOrbit(own, current, documentCamera);
          camera = own;
        }
      } else if (view) {
        // The document's frame fitted into the panel, as the player fits it into its canvas.
        scale = Math.min(width / view.width, height / view.height);
      }
      const frameWidth = width / scale;
      const frameHeight = height / scale;
      drawn = { camera, width: frameWidth, height: frameHeight, scale };
      const background = view?.background;
      renderer.draw(built?.scene ?? empty, camera, {
        width: frameWidth,
        height: frameHeight,
        pixelRatio: ratio * scale,
        ...(background === undefined ? {} : { background }),
      });
      overlay.setTransform(1, 0, 0, 1, 0, 0);
      overlay.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      if (!built) return;
      overlay.save();
      try {
        overlay.setTransform(ratio, 0, 0, ratio, (width / 2) * ratio, (height / 2) * ratio);
        // The gizmo of the selection when it can change its transform; otherwise the overlay
        // draws its axes (when they are shown).
        const node = selectedNode();
        const mode = gizmoMode.value;
        const movable = selectedTransform(node) !== null;
        drawOverlay(
          overlay,
          {
            scene: built.scene,
            camera,
            rig: built.built.rig,
            selected: movable ? null : node,
            scale,
            view: viewCamera.value === 'document' && view ? view : null,
          },
          debugView.value,
        );
        gizmo =
          node && movable
            ? // Scale goes along the node's own axes.
              gizmoFrame(node, camera, mode === 'scale' ? 'local' : gizmoSpace.value, scale)
            : null;
        if (gizmo) drawGizmo(overlay, gizmo, mode, grab?.handle ?? null);
      } catch (error) {
        throw new Error(`its overlay failed: ${error instanceof Error ? error.message : error}`, {
          cause: error,
        });
      } finally {
        // A failure halfway leaves no dashes or fonts behind for the next frame.
        overlay.restore();
      }
    };
    // The gizmo as last drawn, and the drag of one of its handles: what it started from.
    let gizmo: GizmoFrame | null = null;
    let grab: {
      id: number;
      handle: Handle;
      frame: GizmoFrame;
      start: Transform;
      parentInverse: Mat3x4;
      path: NonNullable<typeof state.value.selection>;
      from: { x: number; y: number };
      /** The editor it started in: another document opened meanwhile ends it. */
      editor: EditorDocument;
      /** Whether it has changed the document yet. */
      changed: boolean;
    } | null = null;
    // A pointer event's place in CSS pixels from the viewport's center, as the gizmo is drawn.
    const centered = (event: PointerEvent) => ({
      x: event.offsetX - canvas.clientWidth / 2,
      y: event.offsetY - canvas.clientHeight / 2,
    });
    // Ends the drag as one step to undo; `revert` takes the step back (the document as it was,
    // the drag left to redo).
    const endGrab = (revert = false) => {
      const ended = grab;
      if (!ended) return;
      grab = null;
      try {
        ended.editor.commit();
        if (revert && ended.changed) ended.editor.undo();
      } catch (error) {
        failed('Could not undo the drag', error);
      } finally {
        fit();
      }
    };
    const stop = effect(fit);

    // A primary press on a gizmo handle drags it; otherwise a drag of one pointer turns or pans
    // the orbit, and a primary press that does not move selects.
    let press: {
      id: number;
      x: number;
      y: number;
      lastX: number;
      lastY: number;
      moved: boolean;
      pan: boolean;
      select: boolean;
    } | null = null;
    const onDown = (event: PointerEvent) => {
      // Another pointer while one drags is left out (a second finger).
      if (
        (press && press.id !== event.pointerId) ||
        (grab && grab.id !== event.pointerId) ||
        (event.button !== 0 && event.button !== 1)
      ) {
        return;
      }
      // The middle button pans here, not scrolls or pastes.
      if (event.button === 1) event.preventDefault();
      const at = centered(event);
      const handle =
        event.button === 0 && gizmo ? handleAt(gizmo, gizmoMode.peek(), at.x, at.y) : null;
      const node = handle ? selectedNode() : null;
      const start = selectedTransform(node);
      const path = state.peek().selection;
      // A parent flattened to nothing has no space to move or turn in.
      const parentInverse =
        node && mat3x4.invert(mat3x4.create(), node.parent?.worldMatrix ?? mat3x4.create());
      if (handle && !parentInverse) {
        failed('Could not drag', new Error("the node's parent has a scale of zero."));
        return;
      }
      // Kept while the drag leaves the canvas; a pointer the browser no longer tracks (an event
      // made up by a test) cannot be, and the drag ends at the canvas's edge.
      if (!canvas.hasPointerCapture(event.pointerId)) {
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch (error) {
          if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
        }
      }
      if (handle && gizmo && start && path && parentInverse) {
        grab = {
          id: event.pointerId,
          handle,
          frame: gizmo,
          start,
          parentInverse,
          path,
          from: at,
          editor: editor.peek(),
          changed: false,
        };
        return;
      }
      press = {
        id: event.pointerId,
        x: event.offsetX,
        y: event.offsetY,
        lastX: event.offsetX,
        lastY: event.offsetY,
        moved: false,
        pan: event.button === 1 || event.shiftKey,
        select: event.button === 0,
      };
    };
    const onMove = (event: PointerEvent) => {
      if (grab && event.pointerId === grab.id) {
        if (event.buttons === 0 || grab.editor !== editor.peek()) {
          endGrab();
          return;
        }
        try {
          const { name, value } = dragged(
            grab.handle,
            grab.frame,
            grab.start,
            grab.parentInverse,
            grab.from,
            centered(event),
            snapping.peek() || event.ctrlKey,
          );
          grab.editor.execute(setProp(grab.path, name, value));
          grab.changed = true;
        } catch (error) {
          failed('Could not drag', error);
          endGrab();
        }
        return;
      }
      if (!press || event.pointerId !== press.id) return;
      // Released where the canvas did not hear it (no capture): the drag is over.
      if (event.buttons === 0) {
        press = null;
        return;
      }
      const dx = event.offsetX - press.lastX;
      const dy = event.offsetY - press.lastY;
      press.lastX = event.offsetX;
      press.lastY = event.offsetY;
      if (
        !press.moved &&
        Math.hypot(event.offsetX - press.x, event.offsetY - press.y) < CLICK_DISTANCE
      ) {
        return;
      }
      press.moved = true;
      if (viewCamera.peek() !== 'orbit') return;
      const current = currentOrbit();
      if (!current) return;
      orbit.value = press.pan ? pan(current, own, dx, dy) : turn(current, dx, dy);
    };
    const onUp = (event: PointerEvent) => {
      if (grab && event.pointerId === grab.id) {
        endGrab();
        return;
      }
      const current = press;
      if (!current || event.pointerId !== current.id) return;
      press = null;
      if (current.moved || !current.select) return;
      // A stale scene's paths are an older document's: nothing to pick until it builds again.
      const { scene: built, stale } = state.peek();
      if (!built || stale) return;
      const hit = hits.hitTest(
        built.scene,
        drawn.camera,
        drawn,
        event.offsetX / drawn.scale,
        event.offsetY / drawn.scale,
      );
      if (!hit) {
        editor.peek().select(null);
        return;
      }
      const path = built.sources.get(hit.node);
      // Every built node has a source: a hit without one is a broken map, not an empty click.
      if (path) editor.peek().select(path);
      else console.warn('The viewport hit a node with no place in the document.', hit.node);
    };
    const onWheel = (event: WheelEvent) => {
      const current = currentOrbit();
      if (viewCamera.peek() !== 'orbit' || !current) return;
      event.preventDefault();
      // A wheel that counts lines moves some 16 pixels a line.
      const delta =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
      orbit.value = zoom(current, Math.exp(-delta * 0.001));
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    // The browser took the pointer away: the drag is undone, not kept halfway.
    const onCancel = (event: PointerEvent) => {
      if (press?.id === event.pointerId) press = null;
      if (grab?.id === event.pointerId) endGrab(true);
    };
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    // It also fires once on observing: the first frame, if the effect ran before layout.
    const observer = new ResizeObserver(fit);
    observer.observe(canvas);
    // Moved to a screen of another pixel ratio, the canvas keeps its size: fit it again.
    let ratio: MediaQueryList | null = null;
    const watchRatio = () => {
      ratio?.removeEventListener('change', onRatio);
      ratio = matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`);
      ratio.addEventListener('change', onRatio);
    };
    const onRatio = () => {
      watchRatio();
      fit();
    };
    watchRatio();
    return () => {
      endGrab();
      stop();
      observer.disconnect();
      ratio?.removeEventListener('change', onRatio);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('wheel', onWheel);
      renderer.destroy();
    };
  }, []);
  return (
    <div class="viewport-panel">
      <ViewportBar />
      <div class="viewport-stage">
        <canvas ref={ref} class="viewport" />
        <canvas ref={overlayRef} class="viewport-overlay" />
      </div>
    </div>
  );
}
