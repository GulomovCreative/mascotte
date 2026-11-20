import { Animator, type Node, Scene } from '@mascotte/engine';
import {
  type BuiltMascot,
  buildDocument,
  DocumentError,
  type Issue,
  type MascotDocument,
} from '@mascotte/format';
import type { Command } from './commands.ts';
import { type DocPath, nodeAt, samePath } from './paths.ts';
import { sourceMap } from './sources.ts';

/**
 * A document built for the viewport: the mascot, its scene and animator, and where each built
 * node came from. The `EditorDocument` that made it destroys its scene when a newer one replaces
 * it. While the document has issues this is an older document's scene: `sources` then names
 * paths of that document (check `EditorState.stale` before picking through it).
 */
export interface BuiltScene {
  readonly document: MascotDocument;
  readonly built: BuiltMascot;
  readonly scene: Scene;
  readonly animator: Animator;
  readonly sources: ReadonlyMap<Node, DocPath>;
}

/** The result of `check`: a scene for a document that builds, its issues for one that does not. */
export type Checked =
  | { readonly issues: readonly []; readonly scene: BuiltScene }
  | { readonly issues: readonly [Issue, ...Issue[]]; readonly scene: null };

/**
 * How the viewport shows the document without changing it: a palette (the base without one), and
 * values of its shape parameters (as `buildDocument` takes them). Names the document does not
 * have (any more), and values its parameters' ranges do not allow (any more), are left out.
 */
export interface Preview {
  readonly palette?: string;
  readonly params?: Readonly<Record<string, number>>;
}

/** `preview` without the palette and parameters `document` does not have. */
function previewOf(document: MascotDocument, preview: Preview): Preview {
  const palette =
    preview.palette !== undefined && Object.hasOwn(document.palettes ?? {}, preview.palette)
      ? preview.palette
      : undefined;
  const specs: Readonly<Record<string, unknown>> = document.params ?? {};
  const params = Object.fromEntries(
    Object.entries(preview.params ?? {}).filter(([name, value]) => {
      const spec = Object.hasOwn(specs, name) ? specs[name] : undefined;
      if (typeof spec !== 'object' || spec === null) return false;
      const { default: fallback, min, max } = spec as Record<string, unknown>;
      return (
        typeof fallback === 'number' &&
        Number.isFinite(value) &&
        !(typeof min === 'number' && value < min) &&
        !(typeof max === 'number' && value > max)
      );
    }),
  );
  return {
    ...(palette === undefined ? {} : { palette }),
    ...(Object.keys(params).length === 0 ? {} : { params }),
  };
}

/**
 * Checks a document as the editor needs it: built (which validates the tree, rig and references)
 * and animated, for what only the engine checks (tracks and keys, behaviors, machines,
 * constraints, springs; those come one at a time), as `preview` shows it. The format reports what
 * is wrong with the document as a `DocumentError`; anything else is a bug and is thrown.
 */
export function check(document: MascotDocument, preview: Preview = {}): Checked {
  let built: BuiltMascot;
  let scene: Scene;
  let animator: Animator;
  try {
    built = buildDocument(document, previewOf(document, preview));
    scene = new Scene(built.root);
    animator = new Animator(scene, { rig: built.rig });
    built.animate(animator);
    animator.evaluate();
  } catch (error) {
    if (error instanceof DocumentError && error.issues.length > 0) {
      return { issues: error.issues as [Issue, ...Issue[]], scene: null };
    }
    throw error;
  }
  return {
    issues: [],
    scene: { document, built, scene, animator, sources: sourceMap(built.root, document) },
  };
}

/** What the editor shows at a moment: one immutable value, replaced on every change. */
export interface EditorState {
  readonly document: MascotDocument;
  /** The selected node's path, or `null`. */
  readonly selection: DocPath | null;
  /** The document's issues; empty when it builds and animates. */
  readonly issues: readonly Issue[];
  /** The last scene that built: the document's, or an older one while it has issues. */
  readonly scene: BuiltScene | null;
  /** Whether the scene is older than the document (which has issues now). */
  readonly stale: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** The label of the step `undo` would take back. */
  readonly undoLabel: string | null;
  /** How the viewport shows the document: its palette and parameter values (see `Preview`). */
  readonly preview: Preview;
}

/** One step of the history: the document and selection before a command, and its label. */
interface Step {
  readonly document: MascotDocument;
  readonly selection: DocPath | null;
  readonly label: string;
}

/**
 * The document being edited (docs/EDITOR.md, 3.1): the document, the selection (a document
 * path), the undo history, the issues of the document as it stands, and the last scene that
 * built (kept, and marked stale, while the document has issues). Every change is a `Command`;
 * the history keeps the documents before each, so undo restores them exactly. Commands with the
 * same merge key in a row are one step until `commit` ends the gesture.
 *
 * `state` is one immutable value, a new one after every change, for the interface to watch
 * (`subscribe`). For now every change builds the scene anew; setting a property on the live
 * node without a rebuild comes with the viewport's gizmos and the inspector.
 */
export class EditorDocument {
  readonly #undo: Step[] = [];
  readonly #redo: Step[] = [];
  #open: string | undefined;
  #state: EditorState;
  #preview: Preview = {};
  readonly #listeners = new Set<() => void>();

  constructor(document: MascotDocument) {
    const checked = check(document);
    this.#state = this.#snapshot(document, null, checked.issues, checked.scene);
  }

  /** The editor's state as it stands. */
  get state(): EditorState {
    return this.#state;
  }

  /** Selects the node at `path`, or nothing (also for a path with no node). */
  select(path: DocPath | null): void {
    const { document, selection, issues, scene } = this.#state;
    const next = path !== null && nodeAt(document, path) ? path : null;
    if (samePath(next, selection)) return;
    this.#changed(document, next, issues, scene);
  }

  /**
   * Runs `command`: the document changes, the history gains a step (or merges into the open
   * one). A command that leaves the document as it is only moves the selection, if it does.
   */
  execute(command: Command): void {
    const { document, selection } = this.#state;
    const result = command.run(document, selection);
    if (result.document === document) {
      if (result.selection !== undefined) this.select(result.selection);
      return;
    }
    // Checked before anything changes: a bug thrown here leaves the editor as it was.
    const checked = check(result.document, this.#preview);
    if (command.merge === undefined || command.merge !== this.#open) {
      this.#undo.push({ document, selection, label: command.label });
    }
    this.#redo.length = 0;
    this.#open = command.merge;
    this.#apply(
      result.document,
      result.selection === undefined ? selection : result.selection,
      checked,
    );
  }

  /**
   * Shows the document with `preview`'s palette and parameter values, without changing it (no
   * step); they stay through later changes, as far as the document has them.
   */
  setPreview(preview: Preview): void {
    const { document, selection } = this.#state;
    const checked = check(document, preview);
    this.#preview = preview;
    this.#apply(document, selection, checked);
  }

  /** Ends a gesture: the next command starts a new step even with the same merge key. */
  commit(): void {
    this.#open = undefined;
  }

  /** Takes back the last step. */
  undo(): void {
    this.#travel(this.#undo, this.#redo);
  }

  /** Does again the step `undo` took back. */
  redo(): void {
    this.#travel(this.#redo, this.#undo);
  }

  /**
   * Calls `listener` after every change; returns its removal. A listener that throws does not
   * keep the others from running; the first error is thrown after them all.
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Restores the last step of `from`, keeping the current document as a step of `to`. */
  #travel(from: Step[], to: Step[]): void {
    const step = from.at(-1);
    if (!step) return;
    const checked = check(step.document, this.#preview);
    from.pop();
    to.push({ ...step, document: this.#state.document, selection: this.#state.selection });
    this.#open = undefined;
    this.#apply(step.document, step.selection, checked);
  }

  #apply(document: MascotDocument, selection: DocPath | null, checked: Checked): void {
    let scene = this.#state.scene;
    if (checked.scene) {
      scene?.scene.destroy();
      scene = checked.scene;
    }
    this.#changed(document, selection, checked.issues, scene);
  }

  #snapshot(
    document: MascotDocument,
    selection: DocPath | null,
    issues: readonly Issue[],
    scene: BuiltScene | null,
  ): EditorState {
    return {
      document,
      selection,
      issues,
      scene,
      stale: scene !== null && scene.document !== document,
      canUndo: this.#undo.length > 0,
      canRedo: this.#redo.length > 0,
      undoLabel: this.#undo.at(-1)?.label ?? null,
      preview: previewOf(document, this.#preview),
    };
  }

  #changed(
    document: MascotDocument,
    selection: DocPath | null,
    issues: readonly Issue[],
    scene: BuiltScene | null,
  ): void {
    this.#state = this.#snapshot(document, selection, issues, scene);
    let failure: unknown = null;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== null) throw failure;
  }
}
