// Which `fetch_error.error_class` values mean collection actually lost
// something.
//
// The table holds three different kinds of row, and only one of them is a
// failure:
//
//   - an observation we will never get back (invariant 1: the day is gone)
//   - back-pressure that worked as designed, where the answer is patience
//   - a *finding* about Apple's own data, recorded here because there is
//     nowhere better for it
//
// Every row still belongs in the table and on the data-health page: the
// provenance is the point (invariant 3). What they must not share is a single
// count presented as "collection errors". Measured over the first twelve days,
// half the rows were the second and third kinds, and 11 of those 12 days had at
// least one, so the status badge was red every day and the operator learned to
// read it as decoration. A signal that is always on is the failure it was
// meant to prevent.

/**
 * The classes that are *not* a loss, as a deny-list.
 *
 * Deliberately this way round. A class nobody has classified yet is far more
 * likely to be a new failure than a new kind of harmless, so the default has to
 * be "this cost us something" and adding to this set has to be a decision
 * somebody makes. A whitelist of losses would let a newly introduced class
 * disappear from the badge on the day it starts firing.
 *
 * `do_restarted` is a deploy: every one of them replaces the Durable Object and
 * drops whatever call was in flight. Alarms are at-least-once and every step is
 * idempotent, so the task comes round again. `throttled` and `rate_limited`
 * both put the unit back: Apple rate-limits per
 * IP and Workers egress is shared, so throttles are the normal weather, and the
 * pause plus the next run absorb them, leaving the pair late rather than
 * missing. `skipped_processing_date` and `app_not_in_storefront` are here for a
 * different reason: nothing of ours failed at all. They are findings about
 * Apple's own data that this table is merely the most convenient place to keep.
 * All four stay visible in the breakdown.
 */
export const ABSORBED_ERROR_CLASSES = new Set([
	"app_not_in_storefront",
	"do_restarted",
	"rate_limited",
	"skipped_processing_date",
	"throttled",
]);

/**
 * A null class predates the closed vocabulary and counts as a loss: the rows
 * that carry one were real failures, and guessing them harmless would be the
 * wrong way round.
 */
export function isLoss(errorClass: string | null): boolean {
	return errorClass === null || !ABSORBED_ERROR_CLASSES.has(errorClass);
}
