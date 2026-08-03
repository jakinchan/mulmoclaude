// Reading a cell out of a calculated grid. `0`, `""` and `false` are all
// legitimate cell values, so absence has to be tested explicitly — a truthiness
// check would reject a correct answer, and an assertion on `undefined` would let
// a missing row pass unnoticed.

import type { CellValue } from "../../../../src/plugins/spreadsheet/engine/types.ts";

export const rowAt = (grid: CellValue[][], row: number): CellValue[] => {
  const line = grid[row];
  if (line === undefined) throw new Error(`calculated sheet has no row ${row}`);
  return line;
};

export const cellAt = (grid: CellValue[][], row: number, col: number): CellValue => {
  const cell = rowAt(grid, row)[col];
  if (cell === undefined) throw new Error(`calculated sheet has no cell (${row}, ${col})`);
  return cell;
};
