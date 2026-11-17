import { Animator, type Node, Scene } from '@mascotte/engine';
import {
  type BuiltMascot,
  buildDocument,
  DocumentError,
  type Issue,
  type MascotDocument,
  validateDocument,
} from '@mascotte/format';
import type { Command } from './commands.ts';
import type { DocPath } from './paths.ts';
import { sourceMap } from './sources.ts';

/** A document built for the viewport: the mascot, its scene and animator, and where nodes came from. */
export interface BuiltScene {
  readonly document: MascotDocument;
  readonly built: BuiltMascot;
  readonly scene: Scene;
  readonly animator: Animator;
  readonly sources: ReadonlyMap<Node, DocPath>;
}

/** One step of the history: the document and selection before a command. */
interface Step {
  readonly document: MascotDocument;
  readonly selection: DocPath | null;
  readonly label: string;
  readonly merge: string | undefined;
}

/**
 * Checks a document as the editor needs it: `validateDocument` for the tree, rig and references,
 * then a trial build and animation for what only the engine checks (tracks and keys, behaviors,
 * machines, constraints, springs; those come one at a time). Returns the issues and, for a valid
 * document, its built scene.
 */
export function check(document: MascotDocument): {
  issues: readonly Issue[];
  scene: BuiltScene | null;
} {
  const issues = validateDocument(document);
  if (issues.length > 0) return { issues, scene: null };
  try {
    const built = buildDocument(document);
    const scene = new Scene(built.root);
    const animator = new Animator(scene, { rig: built.rig });
    built.animate(animator);
    animator.evaluate();
    return {
      issues: [],
      scene: { document, built, scene, animator, sources: sourceMap(built.root, document) },
    };
  } catch (error) {
    if (error instanceof DocumentError) return { issues: error.issues, scene: null };
    const message = error instanceof Error ? error.message : String(error);
    return { issues: [{ path: '', message }], scene: null };
  }
}

/**
 * The document being edited (docs/EDITOR.md, 3.1): the document, the selection (a document
 * path), the undo history, the issues of the document as it stands, and the last scene that
 * built (kept, and marked stale, while the document has issues). Every change is a `Command`;
 * the history keeps the documents before each, so undo restores them exactly. Commands with the
 * same merge key in a row are one step until `commit` ends the gesture.
 */
export class EditorDocument {
  #document: MascotDocument;
  #selection: DocPath | null = null;
  #issues: readonly Issue[] = [];
  #scene: BuiltScene | null = null;
  readonly #undo: Step[] = [];
  readonly #redo: Step[] = [];
  #open: string | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(document: MascotDocument) {
    this.#document = document;
    this.#check();
  }

  /** The document as it stands. */
  get document(): MascotDocument {
    return this.#document;
  }

  /** The selected node's path, or `null`. */
  get selection(): DocPath | null {
    return this.#selection;
  }

  /** The document's issues; empty when it builds and animates. */
  get issues(): readonly Issue[] {
    return this.#issues;
  }

  /** The last scene that built: the document's, or an older one while it has issues. */
  get scene(): BuiltScene | null {
    return this.#scene;
  }

  /** Whether the scene is older than the document (which has issues now). */
  get stale(): boolean {
    return this.#scene !== null && this.#scene.document !== this.#document;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  /** The label of the step `undo` would take back. */
  get undoLabel(): string | null {
    return this.#undo.at(-1)?.label ?? null;
  }

  /** Selects the node at `path` (or nothing). */
  select(path: DocPath | null): void {
    this.#selection = path;
    this.#emit();
  }

  /** Runs `command`: the document changes, the history gains a step (or merges into the open one). */
  execute(command: Command): void {
    const result = command.run(this.#document, this.#selection);
    if (result.document === this.#document && result.selection === undefined) return;
    const merging = command.merge !== undefined && command.merge === this.#open;
    if (!merging) {
      this.#undo.push({
        document: this.#document,
        selection: this.#selection,
        label: command.label,
        merge: command.merge,
      });
    }
    this.#redo.length = 0;
    this.#open = command.merge;
    this.#document = result.document;
    if (result.selection !== undefined) this.#selection = result.selection;
    this.#check();
    this.#emit();
  }

  /** Ends a gesture: the next command starts a new step even with the same merge key. */
  commit(): void {
    this.#open = undefined;
  }

  /** Takes back the last step. */
  undo(): void {
    const step = this.#undo.pop();
    if (!step) return;
    this.#redo.push({ ...step, document: this.#document, selection: this.#selection });
    this.#restore(step);
  }

  /** Does again the step `undo` took back. */
  redo(): void {
    const step = this.#redo.pop();
    if (!step) return;
    this.#undo.push({ ...step, document: this.#document, selection: this.#selection });
    this.#restore(step);
  }

  /** Calls `listener` after every change; returns its removal. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #restore(step: Step): void {
    this.#open = undefined;
    this.#document = step.document;
    this.#selection = step.selection;
    this.#check();
    this.#emit();
  }

  #check(): void {
    const { issues, scene } = check(this.#document);
    this.#issues = issues;
    if (scene) this.#scene = scene;
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
