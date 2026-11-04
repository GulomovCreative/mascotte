import { Node, type NodeOptions } from '../scene/node.ts';
import { type ParamSchema, ParamStore } from './params.ts';
import { ShapeStyle, type ShapeStyleValues } from './style.ts';

export interface StyledOptions extends NodeOptions {
  style?: Partial<ShapeStyleValues>;
}

/**
 * Общая основа фигур, поверхностей и составных фигур: стиль и числовые параметры
 * по статической схеме `params`. Подклассы решают, что делать при изменении параметров.
 */
export abstract class Styled<S extends ParamSchema = ParamSchema> extends Node {
  /** Схема числовых параметров класса. */
  static readonly params: ParamSchema = {};
  /** Стиль по умолчанию для класса, поверх значений `ShapeStyle`. */
  static readonly defaultStyle: Partial<ShapeStyleValues> = {};

  readonly style: ShapeStyle;
  // Хранится без типа схемы, чтобы Styled<S> оставался совместим с Styled<ParamSchema>;
  // имена проверяются в getParam и setParam.
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
   * Узел, по глубине начала которого считается перспектива: владелец составной фигуры
   * или сам узел. Так все части составной фигуры масштабируются одинаково и не расходятся.
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

  /** Вызывается после изменения поля стиля. По умолчанию меняет `appearanceVersion`. */
  protected onStyleChanged(): void {
    this.markAppearanceChanged();
  }

  /** Вызывается после изменения числового параметра. */
  protected abstract onParamsChanged(): void;
}
