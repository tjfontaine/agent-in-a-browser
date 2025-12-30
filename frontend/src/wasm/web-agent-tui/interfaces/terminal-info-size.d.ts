/** @module Interface terminal:info/size@0.1.0 **/
export function getTerminalSize(): Dimensions;
export interface Dimensions {
  cols: number,
  rows: number,
}
