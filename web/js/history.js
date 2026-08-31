/* Undo/redo for pattern edits.
 *
 * Kept apart from grid.js and app.js on purpose: this class never touches a
 * payload or the DOM, so it can be exercised directly by a test without a
 * browser. It snapshots the whole 448-byte record per gesture rather than
 * trying to invert individual edits - a 448-byte copy is cheap, and getting an
 * inverse wrong for even one of edit.js's cycles would corrupt a record
 * nothing downstream would notice until it reached a machine.
 */

const DEFAULT_LIMIT = 100;

export class History {
  constructor(limit = DEFAULT_LIMIT) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  /** Record one gesture. The caller decides what `entry` holds - app.js keeps
   *  the file, item and before/after byte snapshots on it - this class only
   *  orders the entries, so it does not need to know their shape.
   *
   * A fresh gesture always clears the redo stack: redoing past an edit made
   * after the undo would silently overwrite it with the old value. */
  push(entry) {
    this.redoStack.length = 0;
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
  }

  /** Pop the most recent gesture onto the redo stack and return it, or null
   *  if there is nothing to undo. Restoring the bytes is the caller's job -
   *  this class tracks order, not payloads. */
  undo() {
    if (!this.undoStack.length) return null;
    const entry = this.undoStack.pop();
    this.redoStack.push(entry);
    return entry;
  }

  /** The mirror of undo(): pop the most recently undone gesture back onto the
   *  undo stack and return it. */
  redo() {
    if (!this.redoStack.length) return null;
    const entry = this.redoStack.pop();
    this.undoStack.push(entry);
    return entry;
  }
}
