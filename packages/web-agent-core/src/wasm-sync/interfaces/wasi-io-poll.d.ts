/** @module Interface wasi:io/poll@0.2.9 **/

export class Pollable {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  ready(): boolean;
  block(): void;
}
