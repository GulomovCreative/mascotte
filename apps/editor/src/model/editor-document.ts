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
 * Checks a document as the editor needs it: built (which validates the tree, rig and references)
 * and animated, for what only the engine checks (tracks and keys, behaviors, machines,
 * constraints, springs; those come one at a time). The format reports what is wrong with the
 * document as a `DocumentError`; anything else is a bug and is thrown.
 */
export function check(document: MascotDocument): Checked {
  let built: BuiltMascot;
  let scene: Scene;
  let animator: Animator;
  try {
    built = buildDocument(document);
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
  #document: MascotDocument;
  #selection: DocPath | null = null;
  #issues: readonly Issue[];
  #scene: BuiltScene | null = null;
  readonly #undo: Step[] = [];
  readonly #redo: Step[] = [];
  #open: string | undefined;
  #state: EditorState;
  readonly #listeners = new Set<() => void>();

  constructor(document: MascotDocument) {
    this.#document = document;
    const checked = check(document);
    this.#issues = checked.issues;
    this.#scene = checked.scene;
    this.#state = this.#snapshot();
  }

  /** The editor's state as it stands. */
  get state(): EditorState {
    return this.#state;
  }

  get document(): MascotDocument {
    return this.#document;
  }

  get selection(): DocPath | null {
    return this.#selection;
  }

  get issues(): readonly Issue[] {
    return this.#issues;
  }

  get scene(): BuiltScene | null {
    return this.#scene;
  }

  get stale(): boolean {
    return this.#state.stale;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  /** Selects the node at `path`, or nothing (also for a path with no node). */
  select(path: DocPath | null): void {
    const next = path !== null && nodeAt(this.#document, path) ? path : null;
    if (samePath(next, this.#selection)) return;
    this.#selection = next;
    this.#changed();
  }

  /**
   * Runs `command`: the document changes, the history gains a step (or merges into the open
   * one). A command that leaves the document as it is only moves the selection, if it does.
   */
  execute(command: Command): void {
    const result = command.run(this.#document, this.#selection);
    if (result.document === this.#document) {
      if (result.selection !== undefined) this.select(result.selection);
      return;
    }
    // Checked before anything changes: a bug thrown here leaves the editor as it was.
    const checked = check(result.document);
    if (!(command.merge !== undefined && command.merge === this.#open)) {
      this.#undo.push({
        document: this.#document,
        selection: this.#selection,
        label: command.label,
      });
    }
    this.#redo.length = 0;
    this.#open = command.merge;
    this.#apply(
      result.document,
      result.selection === undefined ? this.#selection : result.selection,
      checked,
    );
  }

  /** Ends a gesture: the next command starts a new step even with the same merge key. */
  commit(): void {
    this.#open = undefined;
  }

  /** Takes back the last step. */
  undo(): void {
    const step = this.#undo.at(-1);
    if (!step) return;
    const checked = check(step.document);
    this.#undo.pop();
    this.#redo.push({ ...step, document: this.#document, selection: this.#selection });
    this.#open = undefined;
    this.#apply(step.document, step.selection, checked);
  }

  /** Does again the step `undo` took back. */
  redo(): void {
    const step = this.#redo.at(-1);
    if (!step) return;
    const checked = check(step.document);
    this.#redo.pop();
    this.#undo.push({ ...step, document: this.#document, selection: this.#selection });
    this.#open = undefined;
    this.#apply(step.document, step.selection, checked);
  }

  /**
   * Calls `listener` after every change; returns its removal. A listener that throws does not
   * keep the others from running; the first error is thrown after them all.
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #apply(document: MascotDocument, selection: DocPath | null, checked: Checked): void {
    this.#document = document;
    this.#selection = selection;
    this.#issues = checked.issues;
    if (checked.scene) {
      this.#scene?.scene.destroy();
      this.#scene = checked.scene;
    }
    this.#changed();
  }

  #snapshot(): EditorState {
    return {
      document: this.#document,
      selection: this.#selection,
      issues: this.#issues,
      scene: this.#scene,
      stale: this.#scene !== null && this.#scene.document !== this.#document,
      canUndo: this.#undo.length > 0,
      canRedo: this.#redo.length > 0,
      undoLabel: this.#undo.at(-1)?.label ?? null,
    };
  }

  #changed(): void {
    this.#state = this.#snapshot();
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
