# Mascotte editor plan

A separate plan for stage 6 of [PLAN.md](PLAN.md): what the editor is, how it is built, and the
tasks it breaks into. Approved, the tasks become issues in a new stage, the editor itself.

## 1. Goal

A browser app in which a mascot author makes and animates a mascot without writing JSON: builds
its tree from shapes and prefabs, sets its properties, palettes and shape parameters, animates it
on a timeline, wires its emotions in a state machine, previews it in the player as a page shows
it, and saves the document. Everything it saves is a plain mascot document (`@mascotte/format`):
the player reads it as is, and nothing the editor stores is needed to play it.

**Done when** an author can, in the editor alone:

- rebuild Gloop and Miso from an empty document (the tree, prefabs, parameters, palettes, tones,
  outlines and shadow), and Pip's emotion machine (clips, layers, the machine and its inputs,
  the gaze and the crest springs);
- open each reference mascot, change it and save it, and the saved document plays in the player
  as shown in the editor;
- undo and redo every change.

## 2. Settled

- **A web app**, `apps/editor` in the monorepo, on the same engine, format, library and player.
  A desktop wrapper can come later; nothing in the plan depends on one.
- **The document is the source of truth.** The editor edits a `MascotDocument`; the scene on
  screen is built from it. What cannot be saved in a document is not edited.
- **The first version** has all four blocks: the tree and inspector, the viewport with gizmos,
  the animation timeline and the state machine editor.

## 3. Architecture

### 3.1. Document and commands

- `EditorDocument` holds the document being edited, the selection and the undo history.
- Every change is a **command**: a small object that applies a change to the document and knows
  its inverse (set a property, add, remove or move a node, set a key, add a transition, …).
  Undo and redo replay inverses; a drag of a gizmo or a slider is merged into one command.
- After each command the document is **validated** (`validateDocument`). Issues are shown at
  their paths: in the tree, the inspector and a problems list. A document with issues can still
  be edited and saved, but not previewed.
- **Live scene.** A command that sets a property applies it to the live node too, through the
  property registry, so a drag stays smooth. A command that changes the structure (nodes,
  prefabs, parameters, motions, machines) rebuilds the scene from the document; the camera and
  selection survive the rebuild, by node id.
- **Selection** is by node id (and by key, state or transition in their panels), so it survives
  rebuilds and undo.

### 3.2. Files

- **Open and save** a `.json` document: the File System Access API where the browser has it
  (save in place), download and file input elsewhere. The reference mascots open from a menu.
- **A draft** of the open document is kept in the browser's storage and offered back after a
  reload. It is a convenience, not storage: the document is the file.
- **New** starts from an archetype: its slots bound to a minimal tree (a body, eyes, lids).

### 3.3. Viewport

- The scene drawn with `WebGLRenderer` (Canvas 2D where WebGL2 is missing), with its own
  **orbit camera** (turn, pan, zoom) apart from the document's camera, and a toggle to look
  through the document's camera and frame.
- **Picking** with `HitTester`: a click selects the node under the pointer (the solid for its
  parts), and a click on a decal selects the decal.
- **Gizmos** for the selection: move, rotate and scale handles in the node's or the world's
  axes, snapping on demand, each drag one command. Drawn on a 2D overlay over the canvas from the
  node's world matrix and pivot.
- **Debug view** (toggles): node axes and pivots, rig bones and slots, sort order and sort
  points, decal anchors, the frame. Drawn on the same overlay.
- **Engine work** (section 8 of PLAN.md): node bounds in world and screen space for framing and
  gizmos, and the debug view's data (axes, pivots, sort points, anchors), exposed by the engine
  so the overlay does not reach into internals.

### 3.4. Panels

- **Scene tree.** The hierarchy with ids and types; add a shape or a prefab, remove, duplicate,
  reparent by dragging, rename ids (references to the id follow: rig slots, tracks, constraints).
  Rig slots and decals are marked.
- **Inspector.** The selected node's properties, made from the registry: numbers with their
  ranges, vectors, rotations shown as Euler angles and stored as quaternions, colors with a
  palette role picker, enums, booleans. A value can be bound to a shape parameter or a palette
  role, and unbound. Paths and box faces get their own editors.
- **Palettes and parameters.** The document's palettes (roles, colors, the base) with a palette
  switcher for the viewport; shape parameters with their defaults and ranges, and sliders that
  set them for the preview without changing the document.
- **Prefabs.** The library's and the document's; an instance shows its parameters.
- **Rig.** The archetype, its slots and the nodes they bind; problems the format reports (an
  unbound slot, a library motion on the wrong kind of layer) are shown here.

### 3.5. Timeline

- **Motions** of the document: clips, behavior sets, blends and library motions. A clip is edited
  on the timeline; a behavior set, a blend and a library reference in forms.
- **Tracks and keys**: one row per track (node or slot, property); keys added at the playhead
  from the inspector's value ("key this"), moved, copied, deleted; easing per key.
- **Playback**: play, pause, loop, scrub; the animator seeks (`layer.time`, `evaluate`), so a
  frame is the same however it is reached. Springs are off while scrubbing.
- **Layers**: their order, mode, weight and mask, and what each plays.

### 3.6. State machine editor

- Each machine drawn as a **graph**: states as boxes (with the motion each plays), transitions as
  arrows, the any-state as its own box.
- A transition's **conditions**, duration and exit time in a form beside the graph.
- **Inputs**: declared per machine (bool, number, trigger), and driven from an inputs panel while
  previewing, so a transition can be tried at once; the active state is lit.

### 3.7. Preview

- A **player panel**: the document in a `Player` as a page embeds it, with its pointer, gaze and
  turn options, its palettes and parameters; the inputs panel drives it.
- **Export** from the editor: PNG, SVG and frame sequences (`exportFrame`, `exportFrames`).

### 3.8. User interface

- **Layout**: the viewport in the middle, the tree on the left, the inspector on the right, the
  timeline and the state machine editor in tabs at the bottom, the preview in a panel or a window.
- **UI library**: Preact with signals is proposed: small, JSX, and signals fit a store that
  commands change. To approve with the plan.
- **Keys**: undo and redo, delete, duplicate, gizmo modes, play and pause, frame the selection.

## 4. Tasks

In order; each is an issue with its done criterion. Engine work comes with the task that needs it.

1. **Editor app and layout.** `apps/editor` with the UI library, the panel layout and an empty
   viewport; it builds and is tested in CI. *Done when* the app opens with its panels.
2. **Document, commands and undo.** `EditorDocument`, the command set for properties and the
   tree, merged drags, undo and redo, validation shown with paths. *Done when* every command
   undoes to the same document, tested on the reference mascots.
3. **Open, save and drafts.** Open and save files, the reference mascots, new from an archetype,
   the draft after a reload. *Done when* a reference mascot opens, saves and reopens unchanged.
4. **Viewport, picking and debug view.** The orbit camera, the document camera toggle, picking,
   the debug overlay; the engine's bounds and debug data. *Done when* any node of Pip can be
   picked and its axes, the bones and the sort order shown.
5. **Gizmos.** Move, rotate and scale handles, local and world axes, snapping, each drag one
   command. *Done when* Pip's wing can be posed and the pose undone.
6. **Scene tree.** The hierarchy with add, remove, duplicate, reparent and rename, prefabs
   inserted, references following renamed ids. *Done when* Gloop's tree can be built from empty.
7. **Inspector.** Registry-made property editors, parameter and palette bindings, path and face
   editors. *Done when* every property of every node type can be edited and bound.
8. **Palettes, parameters, prefabs and rig.** Their panels and the viewport's palette switcher
   and parameter sliders. *Done when* Miso's palettes, its `catEar` prefab and its slots can be
   made in the editor.
9. **Timeline.** Motions, tracks and keys, easing, playback and scrubbing, layers. *Done when*
   Pip's calm, happy and surprised clips can be made and played.
10. **Behaviors, blends and library motions.** Their forms on the timeline's side. *Done when*
    Gloop's and Miso's idle (breathe, bob, sway, wag, blink) can be set up.
11. **State machine editor.** The graph, transitions and conditions, inputs, the active state.
    *Done when* Pip's emotion machine can be made and tried with the inputs.
12. **Constraints and springs.** Forms for aim, lookAt, IK, copy and limits, and for springs;
    the gaze tried with the pointer. *Done when* Pip's gaze and crest springs can be made.
13. **Preview and export.** The player panel with pointer options, palettes and parameters;
    export. *Done when* every reference mascot rebuilt in the editor plays in the player as the
    original does.

## 5. To approve

- The UI library (Preact with signals is proposed).
- The scope of the first version as in section 1, and the task order in section 4.
- Where the editor is published: with the site (#48) or on its own.
