/**
 * Generic undo stack with clone-on-push semantics.
 *
 * Stores deep clones of state snapshots. Popped snapshots are returned
 * directly (no re-cloning) since they are already detached.
 */
export class UndoStack<S> {
	private stack: S[] = [];
	private readonly clone: (state: S) => S;

	/**
	 * @param clone produces a detached copy of a snapshot.
	 *
	 * scriptc: `structuredClone` has no lowering for these shapes (SC2020) and a
	 * generic deep clone needs runtime reflection, so each instantiation supplies a
	 * concrete cloner for its own snapshot type.
	 */
	constructor(clone: (state: S) => S) {
		this.clone = clone;
	}

	/** Push a deep clone of the given state onto the stack. */
	push(state: S): void {
		this.stack.push(this.clone(state));
	}

	/** Pop and return the most recent snapshot, or undefined if empty. */
	pop(): S | undefined {
		return this.stack.pop();
	}

	/** Remove all snapshots. */
	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
