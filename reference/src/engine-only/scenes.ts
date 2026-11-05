import {
  Camera,
  Capsule,
  Cylinder,
  Ellipse,
  Node,
  PathShape,
  Rect,
  Sphere,
} from '@mascotte/engine';
import { euler } from '@mascotte/math';

/**
 * A new-engine-only scene: checks features Zdog lacks (perspective, stroke scaling, surfaces,
 * layers, transparency, decals). Its snapshots are its own.
 */
export interface EngineScene {
  readonly id: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly background: string;
  build(): { root: Node; camera: Camera };
  pose(root: Node, camera: Camera, time: number): void;
  /** Extra animation times with their own snapshots (besides `time = 0`). */
  readonly snapshotTimes?: readonly number[];
}

const perspective: EngineScene = {
  id: 'engine-perspective',
  title: 'Perspective and scale',
  width: 320,
  height: 240,
  background: '#f4efe6',
  build() {
    const root = new Node();
    const camera = new Camera({ projection: 'perspective', distance: 300, zoom: 1.2 });
    root
      .add(
        new Sphere({
          diameter: 50,
          position: { x: -70, y: -30, z: 60 },
          style: { color: '#e62', stroke: 4 },
        }),
      )
      .add(
        new Sphere({
          diameter: 50,
          position: { x: -80, y: 55, z: -80 },
          style: { color: '#c25', stroke: 4 },
        }),
      )
      .add(
        new Capsule({
          length: 90,
          diameter: 22,
          rotation: euler.create(0, Math.PI / 2, 0.4),
          position: { x: 20, y: -60, z: 20 },
          style: { color: '#27a', stroke: 2 },
        }),
      )
      .add(
        new Cylinder({
          diameter: 40,
          length: 60,
          rotation: euler.create(0.5, 0.9, 0),
          position: { x: 40, y: 40, z: -30 },
          style: { color: '#3a8', backfaceColor: '#ea0', stroke: 2 },
        }),
      );
    // The stroke scales with the node: parent 1.5 and child 2 give ×3 width.
    const scaled = new Node({ scale: 1.5, position: { x: 85, y: -15, z: 0 } });
    scaled.add(new Rect({ width: 14, height: 14, scale: 2, style: { stroke: 2, color: '#636' } }));
    root.add(scaled);
    return { root, camera };
  },
  pose(root, camera, time) {
    root.setRotationFromEuler(euler.create(0, Math.sin(time * 0.7) * 0.5, 0));
    camera.setRotationFromEuler(euler.create(-0.15, 0.2, 0));
  },
};

const layersOpacity: EngineScene = {
  id: 'engine-layers-opacity',
  title: 'Layers, transparency, decals',
  width: 320,
  height: 240,
  background: '#e8f1f2',
  build() {
    const root = new Node();
    const camera = new Camera();
    // The shadow is below everything: layer −1, even though it is closer in depth.
    root.add(
      new Ellipse({
        width: 120,
        height: 26,
        position: { x: 0, y: 95, z: 80 },
        sortMode: 'layer',
        layer: -1,
        style: { fill: true, stroke: 0, color: '#9bb' },
      }),
    );
    const head = new Sphere({ id: 'head', diameter: 110, style: { color: '#f6a623', stroke: 0 } });
    for (const side of [-1, 1]) {
      const eye = new Ellipse({
        diameter: 20,
        sortMode: 'attached',
        position: { x: side * 22, y: -10, z: 50 },
        rotation: euler.create(0.2, side * -0.45, 0),
        style: { fill: true, stroke: 4, color: '#fff' },
      });
      eye.add(
        new PathShape({
          sortMode: 'attached',
          position: { x: 0, y: 0, z: 1 },
          style: { stroke: 9, color: '#222' },
        }),
      );
      head.add(eye);
    }
    root.add(head);
    // A translucent parent over an opaque shape.
    const veil = new Node({ opacity: 0.5, position: { x: 0, y: 0, z: 90 } });
    veil.add(
      new Rect({
        width: 160,
        height: 30,
        position: { x: 0, y: 40, z: 0 },
        style: { fill: true, stroke: 0, color: '#27a' },
      }),
    );
    root.add(veil);
    // The spark is above everything: layer +1, though it is the farthest in depth.
    root.add(
      new PathShape({
        position: { x: 70, y: -70, z: -200 },
        sortMode: 'layer',
        layer: 1,
        style: { stroke: 18, color: '#ed0' },
      }),
    );
    return { root, camera };
  },
  pose(root, _camera, time) {
    const head = root.findById('head');
    head?.setRotationFromEuler(euler.create(0, Math.sin(time * 1.1) * 1.4, 0));
  },
};

/** A point on a sphere of radius `radius` in direction (x, y) on the front side (z > 0). */
function onSphere(x: number, y: number, radius: number): { x: number; y: number; z: number } {
  return { x, y, z: Math.sqrt(Math.max(0, radius * radius - x * x - y * y)) };
}

/** The same point moved out from the sphere center to distance `distance`. */
function along(p: { x: number; y: number; z: number }, distance: number) {
  const length = Math.hypot(p.x, p.y, p.z) || 1;
  return {
    x: (p.x / length) * distance,
    y: (p.y / length) * distance,
    z: (p.z / length) * distance,
  };
}

const mascot3d: EngineScene = {
  id: 'engine-mascot-3d',
  title: 'Mascot in 3D',
  width: 240,
  height: 240,
  background: '#e8f1f2',
  build() {
    const root = new Node();
    const camera = new Camera({ zoom: 1.5 });
    const radius = 40;
    const head = new Sphere({
      id: 'head',
      diameter: radius * 2,
      style: { color: '#f6a623', stroke: 0 },
    });
    for (const side of [-1, 1]) {
      // The ear grows out of the head: its base is inside the sphere.
      head.add(
        new PathShape({
          path: [
            { type: 'move', point: { x: side * 20, y: -20, z: 0 } },
            { type: 'line', point: { x: side * 32, y: -52, z: 0 } },
          ],
          style: { stroke: 16, color: '#e0861a' },
        }),
      );
      // The eyeball sits on the head surface and sticks out of it.
      const surface = onSphere(side * 14, -6, radius);
      head.add(
        new Sphere({
          diameter: 14,
          position: along(surface, radius - 2),
          style: { color: '#ffffff', stroke: 0 },
        }),
      );
      // The pupil is on the eyeball surface.
      head.add(
        new Sphere({
          diameter: 6,
          position: along(surface, radius - 2 + 5),
          style: { color: '#222222', stroke: 0 },
        }),
      );
    }
    // The mouth is a tube lying on the head surface: the tube center is slightly more than half its
    // width above the sphere, otherwise segments between points enter the head and get clipped.
    const mouth = [];
    for (let i = 0; i <= 8; i++) {
      const x = -9 + (18 * i) / 8;
      const y = 12 + (1 - (x / 9) ** 2) * 5;
      mouth.push({
        type: i === 0 ? ('move' as const) : ('line' as const),
        point: along(onSphere(x, y, radius), radius + 2.5),
      });
    }
    head.add(new PathShape({ path: mouth, closed: false, style: { stroke: 4, color: '#8a3b12' } }));
    root.add(head);
    root.add(
      new Sphere({
        diameter: 44,
        position: { x: 0, y: 62, z: 0 },
        style: { color: '#e0861a', stroke: 0 },
      }),
    );
    return { root, camera };
  },
  pose(root, _camera, time) {
    // The head turns almost to profile so the eyes go past its silhouette.
    root.setRotationFromEuler(euler.create(-0.15, Math.sin(time * 0.8) * 1.3, 0));
  },
};

const earBehindHead: EngineScene = {
  id: 'engine-partial-occlusion',
  title: 'Ear behind the head',
  width: 240,
  height: 240,
  background: '#e8f1f2',
  build() {
    const root = new Node();
    const camera = new Camera({ zoom: 1.5 });
    // The head is a point with a thick stroke, as in Zdog; the ears tilt back and cross the
    // head's central plane, so part of each ear goes behind the head.
    const head = new PathShape({ id: 'head', style: { stroke: 80, color: '#f6a623' } });
    for (const side of [-1, 1]) {
      head.add(
        new PathShape({
          id: side < 0 ? 'left-ear' : 'right-ear',
          path: [
            // The base is behind the head's central plane, the tip in front of it.
            { type: 'move', point: { x: side * 18, y: -20, z: -20 } },
            { type: 'line', point: { x: side * 30, y: -62, z: 14 } },
          ],
          style: { stroke: 16, color: '#e0861a' },
        }),
      );
    }
    // A capsule arm: the inner end behind the head, the outer end in front of it.
    head.add(
      new Capsule({
        length: 70,
        diameter: 14,
        position: { x: 25, y: 20, z: 0 },
        rotation: euler.create(0, 1, 0),
        style: { color: '#c25', stroke: 0 },
      }),
    );
    root.add(head);
    return { root, camera };
  },
  pose(root, _camera, time) {
    root.setRotationFromEuler(euler.create(-0.15, Math.sin(time) * 0.8, 0));
  },
  // The head turned fully to one side and to the other.
  snapshotTimes: [Math.PI / 2, (3 * Math.PI) / 2],
};

/** New-engine-only scenes. */
export const engineScenes: readonly EngineScene[] = [
  perspective,
  layersOpacity,
  mascot3d,
  earBehindHead,
];
