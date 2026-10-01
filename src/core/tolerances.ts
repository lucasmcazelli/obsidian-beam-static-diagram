/**
 * Relative tolerances shared by the model builder, the solver, the diagram
 * sampler and the renderers. Keeping them in one dependency-free module
 * stops the copies from drifting apart (a position the model calls "the same"
 * must also be merged by the solver).
 */

/**
 * Relative tolerance (times the beam length) for "same position" checks and
 * for snapping positions to the beam ends or to each other. It only absorbs
 * unit-conversion round-off ("roller at 36 in" on a 3 ft beam lands 1e-16 m
 * short of the end), never a real offset.
 */
export const POSITION_TOL = 1e-9;

/**
 * Largest acceptable global equilibrium residual, as a fraction of the force
 * scale (moment residual: of force scale × L). Healthy beams stay near 1e-15.
 */
export const RESIDUAL_TOL = 1e-6;
