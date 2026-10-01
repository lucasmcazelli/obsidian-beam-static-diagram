/**
 * Ready-made example blocks (editor templates, README, tests).
 * STUB: to be implemented.
 */

export interface BeamExample {
	id: string;
	/** Sentence-case name shown in the editor, e.g. "Simply supported beam". */
	name: string;
	/** Block text without fences. */
	source: string;
}

export declare const BEAM_EXAMPLES: BeamExample[];

/** Text inserted by the "Insert beam" command. */
export declare const DEFAULT_BEAM_SOURCE: string;
