import { Node, type NodeOptions } from '../scene/node.ts';
import { type ParamSchema, ParamStore } from './params.ts';
import { ShapeStyle, type ShapeStyleValues } from './style.ts';

export interface StyledOptions extends NodeOptions {
  style?: Partial<ShapeStyleValues>;
}

/**
 * Common base of shapes, surfaces and solids: style and numeric parameters
 * from the static `params` schema. Subclasses decide what to do when parameters change.
 */
export abstract class Styled<S extends ParamSchema = ParamSchema> extends Node {
  /** Schema of the class's numeric parameters. */
  static readonly params: ParamSchema = {};
  /** Default style for the class, on top of the `ShapeStyle` values. */
  static readonly defaultStyle: Partial<ShapeStyleValues> = {};

  readonly style: ShapeStyle;
  // Stored without the schema type so that Styled<S> stays compatible with Styled<ParamSchema>;
  // names are checked in getParam and setParam.
  readonly #params: ParamStore<ParamSchema>;

  constructor(options: StyledOptions = {}) {
    super(options);
    const type = this.constructor as typeof Styled;
    this.style = new ShapeStyle(() => this.onStyleChanged(), {
      ...type.defaultStyle,
      ...options.style,
    });
    this.#params = new ParamStore(type.params, options, () => this.onParamsChanged());
  }

  /**
   * The node whose starting depth drives perspective: the owner of the solid
   * or the node itself. This way all parts of a solid scale the same and do not drift apart.
   */
  get perspectiveReference(): Node {
    return this.owner ?? this;
  }

  protected getParam(name: keyof S & string): number {
    return this.#params.get(name);
  }

  protected setParam(name: keyof S & string, value: number): void {
    this.#params.set(name, value);
  }

  /** Called after a style field changes. By default bumps `appearanceVersion`. */
  protected onStyleChanged(): void {
    this.markAppearanceChanged();
  }

  /** Called after a numeric parameter changes. */
  protected abstract onParamsChanged(): void;
}
