# Mascotte development plan

This document records the goals, architecture and stages of work on the engine. Update it as decisions are made or revised.

## 1. Goal

An engine for animated mascots in a "2D pseudo-3D" style: round flat forms built from simple primitives that rotate in space, react to the user and live on their own (breathe, blink, follow the cursor).

Mascots are created in a future visual editor. The engine plays back what was assembled there. So the center of everything is the **mascot document format**, not an API for building a scene by hand.

The main requirement: one engine must produce **different mascots**. Different in shape (blob, biped, quadruped, bird), in style and in behavior. And without new code for each one.

## 2. Settled decisions

| Decision | What it means |
|---|---|
| Zdog API compatibility is not needed | The core is written from scratch. Ideas and geometry are taken from Zdog, not the code structure |
| WebGL2 is the main backend, Canvas 2D is the fallback | Per-pixel depth gives real, continuous occlusions and intersections in the flat Zdog style. Canvas 2D draws whole shapes one after another, so occlusion in it is discrete; it remains the fallback for devices without WebGL2 and for export to PNG and SVG. Decision revised on 2026-11-04 (#51); Canvas 2D used to be the main backend |
| Mascots are assembled in the editor | The scene, animations and behavior are described as data (JSON). Code is needed only to embed the player in a page |

## 3. Principles

1. **Data over code.** Everything that can be configured in the editor must be saved to the document and loaded back without loss.
2. **Determinism.** The frame state is fully determined by the document, the time and the inputs. The editor needs seeking to any point, and tests need repeatable results. Randomness only through a seeded generator. Springs are the exception: they depend on the frames played, so the editor seeks with them off or replays them from rest (see 5.9).
3. **Zero work at rest.** If nothing has changed, the frame is not recomputed. The animation loop does no allocations.
4. **Rendering is separate from the scene.** The scene produces a display list, and the backend draws it. The core knows nothing about the DOM and runs in Node and in a worker.
5. **Small player.** The player (runtime) is separate from the editor code. Size target: up to 40 KB gzip.

## 4. What we take from Zdog

A copy of the Zdog core lived in `src/core/` as a reference and the ground truth for images, not as a code base. After parity it was removed (#15); what remains are frozen references: frame snapshots of the reference scenes in `reference/snapshots/zdog/` and numbers for unit tests in `packages/*/test/fixtures/zdog/`. They cannot be regenerated and are compared with the new core as is.

We take:
- the style: thick rounded strokes, a point as a sphere, fill together with stroke;
- the path commands `move / line / bezier / arc` and the Bezier approximation of arcs (coefficient 9/16);
- the geometry of composite primitives: hemisphere (dome via an outline along the normal), cylinder, cone (tangents to the base), box;
- back faces: hide or substitute the color.

We do not take:
- re-transforming vertices at every level of the hierarchy;
- rotations through Euler angles only;
- renderers inside shapes and `isCanvas / isSvg` branches;
- rebuilding the flat scene list and recreating SVG elements every frame;
- the option system via `defaults / optionKeys`;
- `Illustration`, which mixes the DOM, resizing, mouse rotation and rendering.

Bugs found in the copy (for reference, the copy is removed): `optionKeys` deduplication in `anchor.js` does not work; `Vector.rotate*` do not return `this`; there is no `destroy()`, so event listeners are never removed.

The NOTICE mention stays: the project contains borrowed geometry and references drawn by Zdog.

## 5. Architecture

### 5.1. Repository structure

A pnpm workspaces monorepo, TypeScript in strict mode, ES modules.

```
packages/
  math/        vectors, matrices, quaternions, color, easing curves
  engine/      scene, primitives, sorting, rendering, animation, rig
  format/      document schema, validation, versions and migrations
  player/      embedding: document loading, loop, input, resize
apps/
  playground/  examples, debugging, benchmarks
  editor/      editor (separate plan, stage 6)
reference/     reference scenes and frame snapshots
docs/
```

Tools: Vite for the playground and builds, Vitest for tests, `@napi-rs/canvas` for rendering in Node and frame snapshot tests, Vitest browser mode with Playwright and Chromium on SwiftShader for WebGL snapshots, Biome as linter and formatter, CI on GitHub Actions.

### 5.2. Frame pipeline

```
inputs (time, pointer, parameters)
  → state machine          selects and blends clips
  → clips                  keyframes → property values
  → procedural behaviors   blinking, breathing, noise
  → rig constraints        lookAt, IK, limits
  → secondary motion       springs, wobble
  → world matrices         only for nodes flagged dirty
  → geometry               projecting vertices to the screen
  → depth sorting
  → display list
  → backend (WebGL2 or Canvas 2D)
```

Each step is skipped if its inputs have not changed. The scene keeps a shared change counter `changeVersion`: it grows on any node change (structure, transforms, visibility, opacity, style, shape geometry and parameters, sort mode, layer, `zBias`). If neither it, nor the camera, nor the frame size has changed, WebGL2 does not rebuild or draw the frame, and the previous one stays on the canvas.

Allocations in the frame loop are checked by tests with the V8 heap profiler (in Node and in Chrome). At rest there are none. While animating the benchmark (20 mascots with 300 drawable nodes each) there are a few kilobytes per frame: world matrix recomputation and the browser's own WebGL calls. The frame builder's working buffers are typed arrays with their own counters, frame lists are written by index without resetting their length, and floating-point numbers are not passed through non-inlined calls (V8 would box each one into an object).

The benchmark is the "Benchmark: 20 mascots" example in the playground (WebGL2 and Canvas 2D) with CPU frame time. On the development machine a WebGL2 frame including GPU work takes about 7 ms, Canvas 2D about 36 ms: 60 fps at this load requires WebGL2. It has not yet been checked on the average laptop from the stage criterion.

### 5.3. Math (`packages/math`)

- `Vec2`, `Vec3`, `Mat3x4` (affine matrix), `Quat`.
- Allocation-free operations: writing into an output argument, pools of temporary objects.
- Rotations are stored as quaternions. In the editor and the document they can be given as Euler angles with a chosen axis order.
- The order `'XYZ'` means the matrix `Rx · Ry · Rz`. The Zdog rotation `rotate: {x, y, z}` equals the angles `{x, -y, z}` in this order: Zdog has the opposite sign for rotation around Y.
- Color is stored in sRGB with non-premultiplied alpha and blended in OKLab with premultiplied alpha, like CSS `color-mix`. CSS string parsing: hex, `rgb()`, `hsl()`, `oklab()`, `oklch()` (the legacy comma syntax and the modern space syntax with `none`) and `transparent`. There are no other named colors: the editor writes hex.
- Easing: the standard set (in/out/inOut for quad, cubic, quart, quint, sine, expo, circ, back, elastic, bounce), CSS curves, arbitrary `cubic-bezier`, `steps()` with the same modes as in CSS. In the document a curve is described by `EasingSpec` (a name from `easing.named` or the parameters `cubicBezier` and `steps`), and `easing.resolve` turns the description into a function at load time.

### 5.4. Scene

- `Node` stores the local transform (position, quaternion, scale, pivot), visibility, opacity, sort mode and a stable `id`.
- The world matrix is recomputed lazily through a dirty flag that propagates to the subtree.
- Camera: orthographic by default, with weak perspective as an option. The camera is also a node, so it can orbit the mascot or be attached to the rig. The coordinate system is the same as in Zdog: x right, y down, z toward the viewer; the camera looks along −z. The camera node is the picture plane and the center of rotation; in perspective the eye sits `distance` behind it. Scale is taken from the depth of the shape's reference point so that circles stay circles. Camera space is built only from position and rotation: the scale of the node and its ancestors does not affect the frame, and magnification is set by `zoom`.
- The flat list of drawable elements is cached and rebuilt only when the tree structure changes.
- Explicit lifecycle: `destroy()` releases everything, including subscriptions.

### 5.5. Primitives

Parametric shapes. Their parameters are reactive: change a property, and the geometry is recomputed on the next frame. So any parameter can be animated.

- Basic: path, point, line, ellipse and arc, rectangle, rounded rectangle, polygon.
- Solid: sphere, hemisphere, cylinder, cone, box, capsule (mascot bodies and limbs).
- Geometry is cached in local coordinates and projected with one matrix per vertex. The path is assembled into reused buffers (`move`, `line`, cubic curves; arcs are replaced with curves with 9/16 handles, as in Zdog), so animating parameters creates no objects.
- Changing shape parameters increments `geometryVersion`, changing style increments `appearanceVersion`, movement increments `worldVersion`: render caches use these counters to decide what to recompute.
- `Shape` is one path and one style. The style is stored as a single `style` object (stroke, fill, color, back side) so that materials can later replace color in one place. Numeric primitive parameters are described by a static `params` schema: constructors use it to validate input, and the property registry and the document format use it to learn what can be animated and saved.
- Shapes, surfaces and composite shapes inherit a common base `Styled`: style and numeric parameters from the schema, whose names are checked by the compiler.
- Solid primitives are composite nodes (`Solid`) that own child shapes and pass them style, size and position: a box is six `Rect` faces, a cylinder is two `Ellipse` bases and a side, a cone and a hemisphere are a base and a side part. The parts have `owner` set to the shape itself and `id` set to `<shape id>/<key>` (their own `id`s cannot contain `/`). Only the shape itself will be saved to the document, and hit-testing will return the owner.
- Perspective for all parts of a composite shape is computed from the depth of the shape's own origin (`perspectiveReference`); otherwise the parts drift apart in perspective.
- Parts that cannot be described by a 3D path are screen surfaces (`Surface`): sphere, capsule, hemisphere dome, cylinder side, cone surface. They build an outline (`ScreenPath` in pixels relative to the frame center, plus brush parameters) from the camera every frame without creating objects. The formulas follow Zdog; unlike Zdog, the stroke scales with the node.
- Rendering relies on two kinds of elements: shapes with a 3D path (`Shape`) and screen surfaces (`Surface`). Sorting of composite shape parts among themselves is defined by #11.
- The stroke scales with the node (this mode can be turned off).

### 5.6. Draw order

Average depth over points, as in Zdog, causes flicker on faces. So a node has a sort mode:

| Mode | Behavior |
|---|---|
| `auto` | by centroid depth |
| `group` | the subtree is sorted as a single unit, with its own order inside |
| `attached` | a decal on the parent's surface (eye, mouth, spot): drawn right after the parent, visible only when facing the camera |
| `layer` | a fixed layer above or below everything else (shadow, effects) |

On top of this there is a depth offset `zBias` and stable sorting, so that elements with equal depth do not swap places.

How it works (`DepthSorter`):
- A node's depth is the depth of its sort point in camera space plus `zBias`. For a shape with a path it is the average of the command endpoints, as in Zdog; for a hemisphere and a cone it is the centroid, as in Zdog; for everything else it is the origin.
- A non-drawing node in `auto` mode is transparent: its children are sorted together with their siblings. Sorted as a group are a node in `group` mode, a composite shape (always), and a non-drawing node in `layer` or `attached` mode; the mode of such a node only sets the group's position. A group is drawn as a whole at the depth of its sort point.
- A decal is drawn right after its nearest drawable ancestor or composite shape, and only when facing the camera; a hidden or back-facing decal also hides its own decals. Without an anchor a decal is sorted as a regular node. A layer sets the order within its own list (the scene's or the group's).
- In composite shapes the dome, the cylinder side and the cone surface have `zBias = -Infinity` and are drawn first, as in Zdog; cylinder bases and box faces are sorted by depth.
- The structure is rebuilt only when the tree, modes or layers change. `zBias` and visibility are applied every frame and need no rebuild, so animating them and blinking by hiding create no objects. Lists are re-sorted with insertion sort, since the order barely changes between frames.

**Partial occlusion.** A single depth per shape does not let part of an ear go behind the head while another part stays visible. So a stroke that passes behind a solid occluder and covers it on screen is split into the part behind it (drawn before the occluder) and the part in front of it (drawn after). A stroke that lies entirely on the wrong side in the draw order is moved.
- A sphere (`Sphere` and a path point with a thick stroke, the Zdog-style head) cuts with its front surface: a point is hidden if on screen it is inside the silhouette and deeper than the front surface. This is also exact for shapes that enter the sphere, such as an ear growing out of the head. The seam is found along the stroke axis, so the sphere is inflated by half the stroke width: the visible part starts where the edge of the stroke touches the surface.
- Decals on a sphere (eyes, mouth: nodes in `attached` mode and everything inside them) are not cut by the sphere but clipped to its silhouette: when the head turns, the eye slides smoothly past the edge instead of sticking out beyond it or disappearing abruptly. A regular child lying inside the sphere is hidden by it, so details on the head surface should be made as decals.
- A capsule cuts with a plane perpendicular to the view through the middle of its axis; when the capsule tilts toward the view this is an approximation. A capsule is itself cut by larger occluders; a cut capsule occludes nothing.
- Strokes without fill are cut: paths and capsules. Segments and Bezier curves are cut at the roots of the cutting surface equation. Each stroke is cut by at most one occluder: the first in draw order that it intersects on screen.
- Not done yet: cutting filled shapes (except decals), boxes and cylinders as occluders, clipping decals to the silhouette of non-spherical anchors, a cut cache keyed by `worldVersion` (cuts are currently computed every frame).
- Cutting and decal clipping can be turned off (`partialOcclusion: false`), for example to compare a frame with Zdog.

### 5.7. Rendering

**WebGL2 (main, #51).** A stroke with rounded caps is a tube of capsules along the path, a point and a sphere are drawn as spheres, a fill is a flat polygon in its own plane, and the hemisphere and the cylinder and cone sides are their own surfaces. Spheres, capsules and surfaces are drawn as impostor rectangles: shape and depth are computed per pixel. Edges are antialiased with alpha-to-coverage and MSAA, intersection lines with supersampling (2×2 by default, lower on large canvases). Sort layers (`layer`) are drawn one after another, and depth is tested only within a layer. Decals are drawn in order only over the visible pixels of their opaque anchor (stencil); with a translucent anchor they are drawn as regular translucent shapes. Translucent shapes are drawn after the opaque ones of their layer, in sort order, and each shape is blended into a pixel once. Without a background the frame is transparent, and alpha reflects coverage exactly.

**Canvas 2D (fallback).** Described below: draw order, cuts by occluders.


- The scene produces a **display list**: screen paths, stroke and fill style, opacity, clip.
- Cameras are part of `Scene.nodes` as regular nodes; they are skipped when building the display list.
- `DisplayList` assembles the frame: depth sorting, projection of shape paths (perspective from `perspectiveReference`), surface outlines, back sides (hide or recolor), opacity including ancestors. A point is drawn as a circle from the stroke, as in Zdog. Elements and buffers are reused between frames.
- `CanvasRenderer` draws the list: the frame center is the camera origin, `devicePixelRatio` is set per frame, and context state is switched only when it changes. Canvas commands match Zdog as long as nodes are not scaled (unlike Zdog, the stroke width here is multiplied by the node scale). The reference scenes have no node scale, so they produce the same frame as Zdog: this is checked with snapshots and at several points of the animation. What Zdog does not have (perspective, stroke scaling, surfaces, layers, opacity, decals) is checked with the new core's own snapshots. The frame is always cleared, even when a background is set.
- Canvas 2D backend: handling `devicePixelRatio` and its changes, minimal context state switches, running in `OffscreenCanvas` and a worker.
- Export: SVG and PNG of a still frame, a frame sequence for video.
- The backend interface is designed so that the WebGL backend can be added without changes to the scene.

### 5.8. Materials and shading

Without shading mascots look flat; with shading they gain volume. Shading stays stylized:

- Material: base color, shadow color, highlight color, back face color.
- A global light direction. The face tone is picked from a palette by the normal (toon with 2–3 steps).
- For spheres and capsules: an offset clipped fill for shadow and highlight.
- An outline around the silhouette as a style option.
- A simple shadow under the mascot (blob shadow) as a separate layer.

### 5.9. Animation

**Properties.** Each node type publishes a registry of animatable properties with a type (`number`, `vec3`, `quat`, `color`, `bool`, `enum`), a range and a default value. The editor builds its inspector from the same registry. `propertiesOf(node or class)` lists inherited properties first; `findProperty` looks one up by name (`position`, `style.color`, `width`). Numeric shape parameters come from the schema the node actually uses (its class's `params`) and style fields from `ShapeStyle.params`, with defaults taken from the class (`defaultStyle`, `defaultClosed`). Values are read and written without allocations (vectors and quaternions are read into an `out` object), and writes go through the node's own setters, so they are validated and mark the scene as changed. Structural settings (`sortMode`, `layer`, camera `projection`) are listed but not animatable. Custom node types add theirs with `registerProperties`; a subclass registering an inherited name replaces it in place. Enum values come from `SORT_MODES` and `PROJECTIONS`, and the setters reject unknown values. Per-face settings of a box (`setFace`) are not in the registry yet.

**Clips.** A clip contains a duration, a loop mode and tracks. A track specifies a target (a node or a rig slot), a property and keys `{ time, value, easing }`. The clip value at time `t` is computed by a pure function, so seeking in the editor is exact. A clip is plain data (`Clip`, `Track`, `Key`); loop modes are `once`, `loop` and `pingpong`. The easing of a key applies from it to the next one. Numbers and vectors interpolate linearly, quaternions with slerp, colors in OKLab, booleans and enums step; before the first key and after the last one the end value is held. `bindClip(clip, scene)` resolves nodes and registry properties once, validates the keys (sorted, inside the clip, values that fit the property type) and prepares flat arrays; `apply(t)` writes the values without per-frame allocations other than boxed numbers at polymorphic calls and color strings. Keys must lie in the property range; interpolated numbers are clamped into it and rounded for integer properties, so easings that overshoot never produce invalid values. A node destroyed after binding is skipped. A track targets a node by id or a rig slot (`{ slot: 'head' }`, see 5.10); `bindClip(clip, scene, { rig })` resolves slots through the rig.

**Layers and blending.** Layers are override or additive, and each has a weight and a subtree mask. A crossfade runs between states. Example: the base layer plays idle in a loop, an additive layer adds blinking, a layer masked to the head drives the gaze. `Animator(scene, { rig })` (the rig is optional, see 5.10) holds the layers in blend order (`addLayer({ name, mode, weight, mask })`). Every property its clips animate becomes a channel in a shared flat buffer; its value when such a clip is first played is the rest pose, and it is not updated later. Each frame starts from rest: an override layer moves the pose towards its clips by its weight, an additive layer adds the difference of its clips from their first frame scaled by the weight (rotations compose; booleans, enums and `null` colors are not additive), and a mask (a node id or a rig slot) limits a layer to that node and its descendants (the mask is resolved when it is set and whenever its layer plays a motion; membership is taken from the hierarchy then and when clips add channels, not tracked live, and a destroyed masked node lets the layer affect nothing). `layer.play(clip, { fade })` fades the clip in over what the layer showed before, also in the middle of another fade or of a fading `layer.stop({ fade })`: the layer keeps its clips in order, each one moves the layer output towards itself by its fade progress where it animates a channel and towards the pose below where it does not, and once a clip has fully faded in the older ones are dropped. Booleans and enums switch when the blend factor reaches 0.5. The blended pose is written to the nodes once per frame, so the animator owns those properties, and channels no layer animates at the moment return to rest. `update(dt)` advances the layers; `evaluate()` writes the pose for the current layer times, so outside fades setting `layer.time` and evaluating gives the same frame as playback.

**Procedural behaviors** (configured in the editor, without code):
- blinking at random intervals;
- breathing (periodic scaling and offset);
- wobble noise;
- following the pointer via `lookAt`.

A behavior is data: it moves one property of one node between two values, `from` (the neutral one) and `to`, by a curve of time. `oscillate` goes there and back once per `period` (with a `phase`); `blink` goes to `to` and back for `duration` seconds at random moments from `minInterval` to `maxInterval` apart; `noise` wanders smoothly between the values around their middle (gradient noise that passes the middle `frequency` times a second and turns about 1.5 times as often). Values mix like clip keys, so booleans switch half way and a blink can swap an open eye for a closed one. Randomness comes from a 32-bit `seed` through `random.hash` and `random.noise` in `@mascotte/math`, which are pure functions, so a behavior's value depends only on time and seeking is exact. Behaviors play on animation layers in sets (`{ behaviors: [...] }`) exactly like clips: with weights, masks, fades and the additive mode, whose reference is the value at time 0 (the neutral one unless an `oscillate` has a phase). Two behaviors of one set on the same property do not combine; the later one wins. Following the pointer comes with the `lookAt` constraint (#23). The playground mascot (`animatedMascot` in `@mascotte/reference`) waves with a clip, breathes and sways with an additive behavior layer and blinks on a layer masked to the head; another additive layer tilts its head now and then with a `blink` on its rotation.

**Secondary motion.** Springs on nodes make ears, tails and antennae sway and give overshoot when motion stops. `animator.addSpring({ target, tip, frequency, damping, maxAngle })` hangs a spring on a node (one per node; defaults 2 oscillations per second, damping 0.3, no angle limit): a particle in world space is pulled to where the blended pose puts the node's `tip` point, and the node is turned about its pivot (in its parent's space, by `quat.rotationTo`) so that the tip points at the particle, at most `maxAngle` away from the pose. So the tip lags behind any motion of the node or its ancestors and swings past the pose when the motion stops; `frequency` is in oscillations per second and `damping` is a ratio (0 swings forever, 1 settles without overshoot). Springs keep state, so they run at a fixed step (`SPRING_STEP`, 1/120 s) after the layers in `update(dt)`, parents before children (ordered by the current hierarchy every frame; a spring whose node was destroyed moves to the node that replaced it under the same id): the pulling point moves linearly across a frame and the shown particle is moved on by its velocity for the time not yet simulated, so the motion hardly depends on the frame rate, and from rest the same `dt` steps over the same poses give the same motion. A frame longer than `SPRING_MAX_DT` settles them at the pose. The animator owns the rotation of a spring's node, so the turn does not build up. `evaluate()` shows springs in their current state; for seeking in the editor they can be disabled (`springsEnabled = false`, the plain pose) or re-simulated from the start (`resetSprings()` and the same `update` steps). The playground mascot's ears swing on springs when it tilts its head.

**Ticker.** One shared loop per page (`Ticker.shared`): subscriptions receive `dt` in seconds and their own time, large jumps are capped (`maxDelta`, 0.1 s by default), and after a pause the paused time does not go into `dt`. Pauses are set by reasons so that sources do not interfere with each other: the ticker has `'hidden'` (tab hidden) and `'reduced-motion'` (`prefers-reduced-motion`), a subscription has `'offscreen'` (its canvas is outside the viewport, `IntersectionObserver`). While there are no active subscriptions or the ticker is paused, no frames are requested. The core knows nothing about the DOM: frames are requested by a pluggable scheduler (`requestAnimationFrame` by default), and `@mascotte/player` connects it to the page (`bindTickerToPage`, `pauseWhenOffscreen`).

### 5.10. Rig

- Bones are regular nodes marked as bones (`node.bone`, a structural registry property that is not animatable). `Rig(root, slots)` lists the bones of its subtree depth-first (`rig.bones`).
- **Slots** are named rig points (`head`, `eye.L`, `eye.R`, `mouth`, `arm.L`, …): words of letters, digits and `_` joined by dots, bound to node ids (`rig.setSlot`, `rig.removeSlot`). A slot resolves only to a node of the rig's subtree. Animations and behaviors refer to slots, not to specific nodes: wherever a node is targeted (clip tracks, behaviors, layer masks, springs) a target is a node id or `{ slot }`, and the animator resolves slots through its rig (`new Animator(scene, { rig })`). Slots are resolved at the moments ids are looked up, and only while the rig's root is in the animator's scene: when a motion is played (it is compiled then), a mask is set or its layer plays a motion, or a spring is added. So after the rig's slots change (`rig.version`), a layer's motion and its mask move to the new nodes together on the next `play` (the previously bound nodes return to rest), and a target that no longer resolves fails that `play` with an error naming the target and the reason, leaving the layer as it was. A spring stays on its node when its slot is rebound; when its node is destroyed it looks for the node its target resolves to after each change of the tree or the slots, and does nothing until it finds one. `rig.slots` is a copy: slots change only through the rig, so its version is always right. Error messages tell a missing slot (listing the known ones), an id with no node, a node outside the rig and a root outside the scene apart. The playground mascot marks its skeleton as bones and addresses only slots.
- Constraints: `lookAt` and `aim` with angle limits, two-bone IK, copy transform, rotation limits.
- The constraint evaluation order is set explicitly and saved in the document.

### 5.11. Interactivity

- Hit-testing (`HitTester`): which shape is visible at a point of the frame. Shapes are broken down into the same primitives as for WebGL2, and at the point the intersection of the view ray with each one is computed; the visibility rules are the same as when drawing (layers, the nearest shape, decals on a visible anchor). The result is the drawable node and the composite shape it belongs to. The check works per pixel rather than by display list order: in WebGL2 occlusion is decided by per-pixel depth, and the check repeats that so that a hit matches the picture.
- Pointer events (hover, press, drag) become state machine inputs.
- Mouse rotation (like `dragRotate` in Zdog) becomes one of the standard behaviors rather than part of the core.

### 5.12. State machine

- **Inputs:** `bool`, `number`, `trigger`. They are set by pointer events or by page code (`player.setInput('happy', true)`).
- **States:** a clip or a blend of clips by a numeric input (blend 1D).
- **Transitions:** conditions on inputs, blend duration, waiting for the clip to end.
- Several machines can run in parallel on different layers (body, face).

## 6. How different mascots are made

This is the main requirement, and the architecture is built around it.

1. **Archetypes.** Standard slot sets: "blob", "biped", "quadruped", "bird", "object with a face". A mascot declares an archetype and binds its own nodes to the slots.
2. **A library of animations and behaviors by slot.** A "wave a hand" clip or a "look at the cursor" behavior is written for the archetype's slots. So it fits any mascot of that archetype without changes. Differences in proportions are handled by normalizing by bone lengths.
3. **Part prefabs.** Eye (white, pupil, eyelid, highlight), mouth (a set of shapes for emotions), ear, paw. They can be inserted into any mascot with overridden parameters.
4. **Shape parameters.** A mascot publishes parameters (head roundness, ear length, eye size) that drive the geometry. One document yields a whole family of variations.
5. **Skins and palettes.** The palette is stored separately from the shape and changes on the fly: color themes, light and dark mode, branding.
6. **Emotions as data.** An emotion is a named set of poses and face parameters that the state machine blends with the current animation.

Requirement check: by the end of stage 4 at least three mascots of different archetypes must work. All three are assembled only from documents and use the shared animation library.

## 7. Document format

- JSON with an explicit schema version and migrations between versions.
- Schema validation (JSON Schema or similar) with clear error messages.
- Contents: metadata, palettes, a node tree with stable `id`s, rig and slots, prefabs, parameters, clips, behaviors, state machines, inputs.
- Assets are embedded in the document or linked.
- The player and the editor read the format the same way. The editor stores nothing that cannot be reproduced in the player.

## 8. Editor requirements for the engine

So that the editor does not need hacks, the engine provides from the start:

- introspection: node types, their properties and ranges;
- changes through commands, so that undo/redo works;
- seeking and stepping through clips;
- hit-testing and data for gizmos: world matrices, axes, bounds;
- a debug render mode: axes, pivot, bones, sort order;
- hot swapping of the document without recreating the player.

## 9. Stages

Each stage ends in a working state: tests pass, the playground shows the result.

### How to track progress

- Each stage corresponds to a milestone on GitHub, and each item to an issue in that milestone.
- The PR that completes an item has `Closes #N` in its description and ticks the checkbox `[x]` here in the same PR.
- An item is done when its PR is merged into `main`. A stage is done when all its items are done and its "Done when" criterion is met.
- Stage status: **not started**, **in progress**, **done**. It is changed in the same PR that starts or finishes the stage.
- New tasks are first filed as issues in the right milestone, then added to the list below.
- Changes to the decisions in section 2 are recorded as a document in `docs/decisions/`.
- All repository text (code comments, tests, messages, docs, issues, PRs) is written in English.

### Stage 0. Scaffolding

Status: **done** · [milestone](https://github.com/GulomovCreative/mascotte/milestone/1)

- [x] Monorepo: pnpm workspaces, TypeScript strict ([#1](https://github.com/GulomovCreative/mascotte/issues/1))
- [x] Linter, formatter and CI ([#2](https://github.com/GulomovCreative/mascotte/issues/2))
- [x] Playground on Vite ([#3](https://github.com/GulomovCreative/mascotte/issues/3))
- [x] Frame snapshot tests and reference scenes ([#4](https://github.com/GulomovCreative/mascotte/issues/4))

**Done when** CI builds the project and checks frame snapshots.

### Stage 1. Rendering core

Status: **done**, except the 60 fps check on an average laptop · [milestone](https://github.com/GulomovCreative/mascotte/milestone/2)

- [x] math: Vec2, Vec3, Mat3x4, Quat ([#5](https://github.com/GulomovCreative/mascotte/issues/5))
- [x] math: color and easing functions ([#6](https://github.com/GulomovCreative/mascotte/issues/6))
- [x] Scene: Node, lazy world matrices, destroy ([#7](https://github.com/GulomovCreative/mascotte/issues/7))
- [x] Camera: orthographic and weak perspective ([#8](https://github.com/GulomovCreative/mascotte/issues/8))
- [x] Path and basic primitives ([#9](https://github.com/GulomovCreative/mascotte/issues/9))
- [x] Solid primitives ([#10](https://github.com/GulomovCreative/mascotte/issues/10))
- [x] Depth sort modes ([#11](https://github.com/GulomovCreative/mascotte/issues/11))
- [x] Partial occlusion: cutting shapes by occluder depth ([#41](https://github.com/GulomovCreative/mascotte/issues/41))
- [x] Display list and Canvas 2D backend ([#12](https://github.com/GulomovCreative/mascotte/issues/12))
- [x] WebGL2 backend with per-pixel depth ([#51](https://github.com/GulomovCreative/mascotte/issues/51))
- [x] WebGL frame snapshots in tests ([#53](https://github.com/GulomovCreative/mascotte/issues/53))
- [x] Hit-testing ([#13](https://github.com/GulomovCreative/mascotte/issues/13))
- [x] Benchmark and allocation checks ([#14](https://github.com/GulomovCreative/mascotte/issues/14))
- [x] Remove the Zdog copy from src/core ([#15](https://github.com/GulomovCreative/mascotte/issues/15))

**Done when** the reference scenes visually match Zdog, there are no allocations at rest, and the benchmark runs 20 mascots with 300 primitives each at 60 fps on an average laptop.

### Stage 2. Animation

Status: **done** · [milestone](https://github.com/GulomovCreative/mascotte/milestone/3)

- [x] Ticker ([#16](https://github.com/GulomovCreative/mascotte/issues/16))
- [x] Animatable property registry ([#17](https://github.com/GulomovCreative/mascotte/issues/17))
- [x] Clips, tracks and keys ([#18](https://github.com/GulomovCreative/mascotte/issues/18))
- [x] Layers, masks, weights and transitions ([#19](https://github.com/GulomovCreative/mascotte/issues/19))
- [x] Procedural behaviors ([#20](https://github.com/GulomovCreative/mascotte/issues/20))
- [x] Springs and secondary motion ([#21](https://github.com/GulomovCreative/mascotte/issues/21))

**Done when** the example mascot breathes, blinks and waves, and seeking a clip gives the same frame as playback.

### Stage 3. Rig and interactivity

Status: **in progress** · [milestone](https://github.com/GulomovCreative/mascotte/milestone/4)

- [x] Bones and rig slots ([#22](https://github.com/GulomovCreative/mascotte/issues/22))
- [ ] Rig constraints ([#23](https://github.com/GulomovCreative/mascotte/issues/23))
- [ ] State machine and inputs ([#24](https://github.com/GulomovCreative/mascotte/issues/24))
- [ ] Pointer events and mouse rotation ([#25](https://github.com/GulomovCreative/mascotte/issues/25))

**Done when** the mascot follows the cursor, reacts to hover and click, and switches emotions.

### Stage 4. Format and player

Status: **not started** · [milestone](https://github.com/GulomovCreative/mascotte/milestone/5)

- [ ] Document schema, validation, versions and migrations ([#26](https://github.com/GulomovCreative/mascotte/issues/26))
- [ ] Player package ([#27](https://github.com/GulomovCreative/mascotte/issues/27))
- [ ] Archetypes and slot-based animation library ([#28](https://github.com/GulomovCreative/mascotte/issues/28))
- [ ] Part prefabs and shape parameters ([#29](https://github.com/GulomovCreative/mascotte/issues/29))
- [ ] Palettes and skins ([#30](https://github.com/GulomovCreative/mascotte/issues/30))
- [ ] Three reference mascots ([#31](https://github.com/GulomovCreative/mascotte/issues/31))

**Done when** three mascots of different archetypes run in the playground from JSON and use shared animations.

### Stage 5. Visual style

Status: **not started** · [milestone](https://github.com/GulomovCreative/mascotte/milestone/6)

- [ ] Materials and toon shading ([#32](https://github.com/GulomovCreative/mascotte/issues/32))
- [ ] Outline and shadow under the mascot ([#33](https://github.com/GulomovCreative/mascotte/issues/33))
- [ ] Frame export ([#34](https://github.com/GulomovCreative/mascotte/issues/34))

**Done when** the reference mascots look three-dimensional and the export matches the in-browser render.

### Stage 6. Editor

Status: **not started** · [milestone](https://github.com/GulomovCreative/mascotte/milestone/7)

- [ ] Editor plan ([#35](https://github.com/GulomovCreative/mascotte/issues/35))

**Done when** a separate editor plan is approved and broken down into tasks.

Minimum editor scope: scene tree, property inspector, viewport with gizmos, key timeline, state machine editor, palettes, document save and load, preview in the player.

## 10. Open questions

- Is perspective needed as the main mode, or is orthographic with weak perspective enough?
- Framework wrappers (React, Vue, Web Component): which ones are needed and when?
- Editor technology: a web app, a desktop wrapper, or both?
- Import and export to third-party formats (Lottie, Rive): are they needed, and in which direction?
- Publishing: npm package name, license for the archetype and animation library.
