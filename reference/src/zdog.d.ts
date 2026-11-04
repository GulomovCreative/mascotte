// Минимальные типы для копии Zdog из src/core. Описано только то, что нужно эталонным сценам.
declare module '@mascotte/zdog-reference' {
  /** Методы двумерного контекста, которые вызывает рендерер Zdog. */
  type CanvasContext = Pick<
    CanvasRenderingContext2D,
    | 'beginPath'
    | 'moveTo'
    | 'lineTo'
    | 'bezierCurveTo'
    | 'arc'
    | 'closePath'
    | 'stroke'
    | 'fill'
    | 'strokeStyle'
    | 'fillStyle'
    | 'lineWidth'
  >;

  interface VectorLike {
    x?: number;
    y?: number;
    z?: number;
  }

  type PathPart =
    | VectorLike
    | { move: VectorLike }
    | { line: VectorLike }
    | { arc: [VectorLike, VectorLike] }
    | { bezier: [VectorLike, VectorLike, VectorLike] };

  interface AnchorOptions {
    addTo?: Anchor;
    translate?: VectorLike;
    rotate?: VectorLike;
    scale?: number | VectorLike;
  }

  interface ShapeOptions extends AnchorOptions {
    stroke?: number | boolean;
    fill?: boolean;
    color?: string;
    closed?: boolean;
    visible?: boolean;
    backface?: boolean | string;
    front?: VectorLike;
    path?: PathPart[];
  }

  class Vector {
    x: number;
    y: number;
    z: number;
  }

  class Anchor {
    constructor(options?: AnchorOptions);
    translate: Vector;
    rotate: Vector;
    scale: Vector;
    children: Anchor[];
    updateGraph(): void;
    renderGraphCanvas(ctx: CanvasContext): void;
  }

  class Shape extends Anchor {
    constructor(options?: ShapeOptions);
  }

  class Group extends Anchor {
    constructor(options?: AnchorOptions & { visible?: boolean; updateSort?: boolean });
  }

  class Rect extends Shape {
    constructor(options?: ShapeOptions & { width?: number; height?: number });
  }

  class RoundedRect extends Shape {
    constructor(
      options?: ShapeOptions & { width?: number; height?: number; cornerRadius?: number },
    );
  }

  interface EllipseOptions extends ShapeOptions {
    diameter?: number;
    width?: number;
    height?: number;
    quarters?: number;
  }

  class Ellipse extends Shape {
    constructor(options?: EllipseOptions);
  }

  class Polygon extends Shape {
    constructor(options?: ShapeOptions & { radius?: number; sides?: number });
  }

  class Hemisphere extends Ellipse {
    constructor(options?: EllipseOptions);
  }

  /** Грань: `false` убирает её, строка задаёт цвет, `true` берёт цвет фигуры. */
  type Face = boolean | string;

  class Cylinder extends Shape {
    constructor(options?: ShapeOptions & { diameter?: number; length?: number; frontFace?: Face });
  }

  class Cone extends Ellipse {
    constructor(options?: EllipseOptions & { length?: number });
  }

  class Box extends Anchor {
    constructor(
      options?: ShapeOptions & {
        width?: number;
        height?: number;
        depth?: number;
        frontFace?: Face;
        rearFace?: Face;
        leftFace?: Face;
        rightFace?: Face;
        topFace?: Face;
        bottomFace?: Face;
      },
    );
  }

  const Zdog: {
    TAU: number;
    Vector: typeof Vector;
    Anchor: typeof Anchor;
    Shape: typeof Shape;
    Group: typeof Group;
    Rect: typeof Rect;
    RoundedRect: typeof RoundedRect;
    Ellipse: typeof Ellipse;
    Polygon: typeof Polygon;
    Hemisphere: typeof Hemisphere;
    Cylinder: typeof Cylinder;
    Cone: typeof Cone;
    Box: typeof Box;
  };

  export type { Anchor, CanvasContext };
  export default Zdog;
}
