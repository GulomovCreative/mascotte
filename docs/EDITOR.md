# Mascotte editor plan

A separate plan for stage 6 of [PLAN.md](PLAN.md): what the editor is, how it is built, and the
tasks it breaks into, issues in stage 7 of PLAN.md.

## 1. Goal

A browser app in which a mascot author makes and animates a mascot without writing JSON: builds
its tree from shapes and prefabs, sets its properties, palettes and shape parameters, animates it
on a timeline, wires its reactions in state machines, previews it in the player as a page shows
it, and saves the document. Everything it saves is a plain mascot document (`@mascotte/format`):
the player reads it as is, and nothing the editor stores is needed to play it.

**Done when** an author can, in the editor alone:

- rebuild Gloop and Miso from an empty document: the tree, the prefabs (Miso's `catEar` with its
  `length` parameter included), the shape parameters, the palettes, the shadow colors
  (`style.shadowColor`), the outlines and the blob shadow; their layers and library motions; the
  `react` machine that hops on a poke; Miso's `gaze`;
- rebuild Pip's animation: the calm, happy and surprised clips, the layers, the emotion machine
  and its inputs, the gaze and the crest springs (Pip's tree is built in code and opened as a
  document);
- open each reference mascot, change it and save it, and the saved document plays in the player
  as shown in the editor;
- undo and redo every change.

## 2. Settled

- **A web app**, `apps/editor` in the monorepo, on the same engine, format, library and player.
  A desktop wrapper can come later; nothing in the plan depends on one.
- **The document is the source of truth.** The editor edits a `MascotDocument`; the scene on
  screen is built from it. What cannot be saved in a document is not edited.
- **Commands live in the editor**, not in the engine: the engine and format stay plain data and
  objects (PLAN.md section 8 is updated to say so).
- **The first version** has all four blocks: the tree and inspector, the viewport with gizmos,
  the animation timeline and the state machine editor.

## 3. Architecture

### 3.1. Document, identity and commands

- `EditorDocument` holds the document being edited, the selection and the undo history.
- **Identity.** A node of the document is addressed by its **path** in the document tree
  (`root.children[1].children[0]`), not by its id: ids are optional, and nodes inside a prefab
  instance or a solid's parts have no node of their own in the document. The editor maps each
  built node to the document path it came from by walking the built tree beside the document
  (building keeps the order: a solid's own parts carry an `owner`, and a prefab instance's own
  children come before the prefab's nodes). A picked live node maps to its document node; a node
  inside a prefab instance maps to the instance, a solid's part to the solid.
- **Ids.** A node the editor creates gets an id at once, unique against the **expanded** tree
  (prefab instances prefix their nodes' ids, so `eye` + `left` must not collide with a node
  `eye-left`). Nodes opened without ids keep none until something needs one (a track, a slot, a
  constraint): then the editor gives it one, as a command.
- **Commands.** Every change is a small object that makes a new document from the current one
  (set a property, add, remove or move a node, set a key, add a transition, …); documents share
  what a change leaves alone, so the history keeps the document before each step and undo
  restores it exactly. A drag of a gizmo or a slider merges into one step until the gesture ends.
  A command that also sets a live node checks its value first (ranges, types).
- **Renaming an id** (or a prefab instance, whose id prefixes its nodes') updates everything that
  names it: rig slots, track and behavior targets, layer masks, constraint `target`, `at`, `mid`,
  `pole` and `from`, spring targets.
- **Validation** after each command: `validateDocument` for the tree, rig, archetype, motion
  references and layer kinds, then a trial `buildDocument` and `animate` for what only the
  engine checks (tracks and keys, behaviors, transitions and conditions, constraint and spring
  fields). Issues are shown at their paths in the tree, the inspector and a problems list;
  the engine's animation problems come one at a time.
- **An invalid document is still edited and saved.** The viewport keeps the last scene that
  built and marks it stale; the preview waits for a valid document.
- **State for the interface.** The model gives one immutable state (document, selection, issues,
  scene, whether it is stale, undo and redo), a new value after every change, for signals to watch.
- **Live scene.** (For now every change rebuilds the scene; the live path below comes with the
  viewport's gizmos and the inspector.) A command that sets a plain property applies it to the live node too, through
  the property registry, so a drag stays smooth; a bound value (a parameter or palette reference)
  is resolved first. A command that changes the structure (nodes, prefabs, parameters, motions,
  machines) rebuilds the scene from the document, keeping the camera, the selection (by path),
  the playhead, the palette and the inputs. **Budget**: a rebuild of a reference mascot within
  one frame; parameter sliders throttle to one rebuild a frame.

### 3.2. Files

- **Open** with `readDocument`, which migrates an older document; **save** writes the current
  version. The File System Access API saves in place where the browser has it; elsewhere,
  download and file input. The reference mascots open from a menu.
- **A draft** of the open document, with its version, is kept in the browser's storage and
  offered back after a reload. It is a convenience, not storage: the document is the file.
- **New** starts from an archetype: a node for each of its required slots (`root`, `body`,
  `eyes`, `lids` and the archetype's own, such as `head`, `wing.L`, `wing.R` and `beak.lower` for
  a bird), bound in the rig, so the new document is valid.
- "Saves and reopens unchanged" means the reopened document is deep-equal to the saved one after
  migration, not byte-equal to the file first opened.

### 3.3. Viewport

- The scene drawn with `WebGLRenderer` (`CanvasRenderer` where WebGL2 is missing), with its own
  **orbit camera** (turn, pan, zoom) apart from the document's camera, and a toggle to look
  through the document's camera and frame.
- **Picking** with `HitTester`: a click selects the document node under the pointer (a solid for
  its parts, a prefab instance for its nodes, a decal itself). Blob shadows are not picked (the
  hit test passes through them); they are selected in the tree.
- **Gizmos** for the selection: move, rotate and scale handles in the node's or the world's
  axes, snapping on demand, each drag one command. Drawn on a 2D overlay over the canvas from the
  node's world matrix and pivot. A move and a turn snap how far they go (whole units, 15°), a
  scale the scale it ends at (0.1); a scale never reaches zero. A ring seen edge-on turns by the
  angle swept round the center, so a drag along it does little until it passes the center.
- **Debug view** (toggles): node axes and pivots, rig bones and slots, sort order and sort
  points, decal anchors, the frame. Drawn on the same overlay.
- **Engine work**: node bounds in world and screen space (for framing the selection, not yet
  scheduled), and the debug view's data (sort points and runs, decal anchors), exposed by the
  engine so the overlay does not reach into the depth sorter's internals.

### 3.4. Panels

- **Document.** `meta`, the frame (`view`: size, background), the camera (`camera.props`:
  projection, zoom, distance, light), the archetype, and the palettes, parameters, prefabs and
  rig below. Shown in the inspector while nothing is selected (Escape in the tree, or a click on
  nothing in the viewport); in a prefab's mode, the prefab's description and parameters.
- **Scene tree.** The hierarchy with ids and types; add a shape or a prefab instance, remove,
  duplicate, reparent by dragging (onto a row's middle to go inside it, its edges to go before
  or after it), rename. Rig slots, decals and prefab instances are marked;
  a prefab instance's own nodes are shown read-only under it.
- **Inspector.** The selected node's properties, made from the registry: numbers with their
  ranges, vectors, rotations shown as Euler angles (degrees, XYZ) and stored as quaternions,
  colors with a palette role picker, enums, booleans; paths (their points) and box faces
  (visibility and color) with their own editors. **Rest values**: the inspector shows and edits
  the values the document stores (`props`), not the animated pose; with auto-key on (it comes
  with the timeline), an edit at the playhead will set a key instead. A prefab instance shows
  the properties of its prefab's root, its own over the root's; its path and faces are the
  prefab's. Each edit is one undo step.
- **Bindings.** A number, a vector or a color can be bound: a number or vector to shape
  parameters (`param × times + plus`, `plus` itself a reference, so a value can follow several
  parameters; a vector reference is a whole vector), a color to a palette role. Booleans and
  enums cannot. Path points can be bound as vectors.
- **Palettes and parameters.** The document's palettes (roles, colors, the base) with a palette
  switcher for the viewport; shape parameters with their defaults and ranges, and sliders that
  set them for the viewport without changing the document. Both are in the document panel; the
  viewport's palette and parameter values stay through edits, as far as the document has them.
- **Prefabs.** The library's and the document's. An instance shows its parameters, each a number
  or bound to a document parameter, and its `props` over the prefab root's (the root's values as
  its parameters make them). A **prefab definition** is edited in its own mode (its tree,
  parameters and bindings, as for a document): the tree, the inspector and the viewport show the
  prefab as a document of its own, in the document's frame, camera and palettes, and its edits
  reach the document as one step when the mode ends (Done; Cancel drops them). Meanwhile the file
  waits (no new, open or save), and the draft keeps the document with the prefab as it is being
  edited. A library prefab edited becomes the document's own, which takes the library's place in
  the document. Renaming an id inside a prefab does not yet rename what the document names it by
  (`instance-id` in slots and tracks). A subtree can be **extracted** into a new prefab: an
  instance takes its place with its id (one from the prefab's name if it has none), name and
  transform; ids under it lose the instance's prefix (or are renamed to the prefixed id
  everywhere), and the document parameters it uses become the prefab's, bound to the
  document's, so the expanded tree stays as it was. A subtree whose ids the instance would make
  twice, or make as another node's, is refused.
- **Rig.** The archetype, its slots and the nodes they bind; problems the format reports (an
  unbound slot, a library motion on the wrong kind of layer) are shown here.

### 3.5. Timeline

- **Motions** of the document: clips, behavior sets, blends and library motions. A clip is edited
  on the timeline; a behavior set, a blend and a library reference in forms.
- **Tracks and keys**: one row per track (target, property). A track of a node bound to a rig
  slot targets the slot by default (as the library's and the reference clips do), and can be
  switched to the node's id. Keys are added at the playhead ("key this", or auto-key), moved,
  copied, deleted; easing per key.
- **Playback and scrubbing**: play, pause, loop, scrub. The edited clip is previewed **solo**:
  its layer alone, machines muted, springs off; the animator then seeks it (`layer.time` and
  `evaluate`), so a frame is the same however it is reached. Fades, springs and machine states
  cannot be sought; they play only in the preview.
- **Layers**: their order, mode, weight and mask, and what each plays.
- **In the editor** (the Timeline tab): a clip opened is previewed solo at the playhead, on a scene
  of its own with the viewport's palette and parameter values (`Preview.solo`; seeking sets the
  layer's time and evaluates, without a rebuild while that scene plays the clip). A clip the
  engine refuses is the clip's issue, and the last scene is shown stale. "Key this" keys a
  property of the selected node with the value it shows at the playhead; with auto-key on, an
  inspector edit of an animatable property keys it there instead of setting its rest value (a
  binding or a cleared value is refused then), and the inspector shows the value at the
  playhead. Keying a node adds to its track however the track names it (its slot or its id). A
  key is moved by its time, given an easing by name, copied to the playhead or deleted (moved or
  copied onto another key, it replaces it); a track names a slot or the node's id, switched
  either way. A key's value is set by keying again. Keys take literal values: a color keyed while
  a palette is previewed is that palette's.
- **Motion forms** (in the Timeline tab, in place of a clip's timeline): a behavior set's
  behaviors (kind, target, property, its two ends edited as the inspector edits values, starting
  at the node's rest value, and the numbers each kind takes); a blend's number input (the
  machines' number inputs are suggested) and its points, kept in strictly increasing order of
  `at` (an `at` another point has is refused), each naming a motion that is no blend; a library
  motion, with what it does and the kind of layer it is written for (a layer of the other kind is
  the layer's issue), the ones the rig cannot play marked. None is previewed solo: they play in
  the preview, on the layers that play them.

### 3.6. State machine editor

- Each machine drawn as a **graph**: states as boxes (with the motion each plays), transitions as
  arrows, the any-state as its own box.
- A transition's **conditions**, duration and exit time in a form beside the graph.
- **Inputs**: declared per machine (bool, number, trigger), and driven from an inputs panel while
  previewing, so a transition can be tried at once; the active state is lit.
- **In the editor** (the State machines tab): the machine open drawn as a graph (the any-state
  first, then its states in a row, transitions as arrows, one into its own state as a loop; the
  selected transition and the active state lit), with forms below it for its name, layer and
  first state, its inputs (changing an input's type starts its conditions over at the new kind's
  default; removing it removes them), its states (renaming one renames it in every transition and
  the first state; removing one removes its transitions and the first state it was; a machine
  keeps one) and the transition selected (its ends, conditions on the machine's inputs, duration
  and exit time; a new one starts with a condition on the first input). "Play" closes a clip
  previewed solo and steps the document's animator every frame (its layers, machines,
  constraints and springs), the inputs driven from the panel; Stop, closing the tab, or issues
  in the document stop it and build the scene again at rest.

### 3.7. Constraints and springs

- Forms for the constraint kinds: `aim`, `lookAt`, `twoBoneIK`, `copyTransform` and
  `limitRotation`, with their targets (ids or slots), weights and names; for springs: target,
  tip, frequency, damping, angle limit. A named `aim` or `lookAt` aimed at a point is tried as a
  gaze with the pointer.

### 3.8. Preview

- A **player panel**: the document in a `Player` as a page embeds it, swapped in place with
  `load` after each valid change; its pointer, gaze and turn options set in the panel (the player
  is made anew when they change, as they are fixed when it is made; `turn` needs the `root`
  slot's rotation un-animated). The palette and parameters follow the editor's; the inputs panel
  drives it.
- **Export**: PNG, SVG and frame sequences (`exportFrame`, `exportFrames`). Sequences play from
  the document's start with default inputs; exporting a reaction (a poke, hovering) needs inputs
  in the export options (player work in that task).

### 3.9. User interface

- **Layout**: the viewport in the middle, the tree on the left, the inspector on the right, the
  timeline and the state machine editor in tabs at the bottom, the preview in a panel or a window.
- **UI library**: Preact with signals: small, JSX, and signals fit a store that commands change.
- **Keys**: undo and redo, delete, duplicate, gizmo modes, play and pause, frame the selection.

### 3.10. Testing

- **Unit tests** (Vitest, Node) for the document model: every command undoes to the same
  document, ids stay unique, renames follow every reference, on the reference mascots.
- **Browser tests** (Vitest browser mode with Chromium, as `test:gl` runs today) for the
  viewport and panels: picking, a gizmo drag becoming one command, the inspector setting and
  binding values, the timeline and machine editors.
- The editor's build and both kinds of tests run in CI; the root `build` script builds every app, and
  `dev:editor` serves the editor.

## 4. Tasks

In order; each is an issue with its done criterion. Engine, format and player work comes with
the task that needs it.

1. **Editor app and layout.** `apps/editor` with the UI library, the panel layout, an empty
   viewport, the scripts and CI. *Done when* the app opens with its panels and its tests run in
   CI.
2. **Document model.** `EditorDocument`: paths, the built-node-to-path map, ids
   unique against the expanded tree, the commands for properties and the tree, merged drags,
   undo and redo, renames that follow every reference, validation with the trial build, the last
   good scene. *Done when* every command undoes to the same document, tested on the reference
   mascots.
3. **Files.** Open with migration, save, drafts, the reference mascots, new from an archetype.
   *Done when* a reference mascot opens, saves and reopens deep-equal, and a new document of each
   archetype is valid.
4. **Viewport, picking and debug view.** The orbit camera, the document camera toggle, picking
   to document nodes, the debug overlay from the engine's debug data. *Done when* any node
   of Pip can be picked and its axes, the bones and the sort order shown.
5. **Gizmos.** Move, rotate and scale handles, local and world axes, snapping, each drag one
   command. *Done when* Pip's wing can be posed and the pose undone.
6. **Scene tree and document panel.** The hierarchy with add, remove, duplicate, reparent and
   rename, prefab instances, the document's frame, camera and archetype. *Done when* Gloop's tree
   can be built from an empty document.
7. **Inspector and bindings.** Registry-made property editors, rest values, parameter and palette
   bindings, path and face editors. *Done when* every property of every node type can be edited,
   and every number, vector and color bound.
8. **Palettes, parameters, prefabs and rig.** Their panels, the palette switcher and parameter
   sliders, prefab definitions edited and extracted, instance parameters bound. *Done when*
   Miso's palettes, its `catEar` prefab with its `length` parameter and its slots can be made.
9. **Timeline.** Motions, tracks and keys (slots by default), easing, solo playback and
   scrubbing, auto-key, layers. *Done when* Pip's calm, happy and surprised clips can be made and
   played.
10. **Behaviors, blends and library motions.** Their forms beside the timeline. *Done when*
    Gloop's and Miso's idle and reactions (breathe, bob, sway, tilt, wag, blink, hop) can be set
    up on their layers.
11. **State machine editor.** The graph, transitions and conditions, inputs, the active state.
    *Done when* Pip's emotion machine and the `react` machines of Gloop and Miso can be made and
    tried with the inputs.
12. **Constraints and springs.** Their forms; the gaze tried with the pointer. *Done when* Pip's
    and Miso's gaze and Pip's crest springs can be made.
13. **Preview and export.** The player panel with its options, palettes, parameters and inputs;
    export, with inputs for sequences (player work). *Done when* every reference mascot rebuilt in
    the editor plays in the player as the original does, and a poke can be exported as frames.

## 5. Approved

- The plan, the scope of the first version and the task order.
- **UI library**: Preact with signals.
- **Publishing**: the editor is published with the project site (#48).

The tasks are issues #85–#97 in the "Stage 7. Editor" milestone.
