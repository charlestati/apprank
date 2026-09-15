// Scoring a proposed keyword against the set an operator already tracks.
//
// Kept apart from the Ollama and wrangler plumbing so it can be tested without
// either: everything here is arithmetic over vectors somebody else fetched.
//
// Why this exists. The collector proposes a keyword only when it shares a whole
// word with the seed Apple answered, which is the best rule a Worker can apply
// without a model. It is wrong in both directions. It admits same-word false
// friends (an unrelated app that shares a short seed word or a brand name),
// and it rejects real variants that share no word at all. Meaning is the
// question, so ask a model that has some.

/** Cosine similarity. Vectors from an embedding model are not unit length. */
export function cosine(a, b) {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (const [i, ai] of a.entries()) {
		const bi = b[i] ?? 0;
		dot += ai * bi;
		na += ai * ai;
		nb += bi * bi;
	}
	const norm = Math.sqrt(na) * Math.sqrt(nb);
	return norm === 0 ? 0 : dot / norm;
}

/**
 * Closeness to the *nearest* tracked keyword, not to their average.
 *
 * A tracked set spans several subjects at once: crosswords, anagrams, daily
 * word puzzles, the app's own brand. Their centroid is a point that means none
 * of them, and scoring against it would rank a term that is vaguely like
 * everything above one that is exactly like something. The nearest neighbour
 * also names itself, so the report can say which keyword a candidate resembles
 * and the operator can disagree with the evidence rather than with a number.
 */
export function nearest(candidateVector, tracked) {
	// Named `nearest`, not `term`: the result is spread over the candidate, and
	// a second `term` would silently overwrite the one being scored.
	let best = { nearest: null, score: -1 };
	for (const t of tracked) {
		const score = cosine(candidateVector, t.vector);
		if (score > best.score) {
			best = { nearest: t.term, score };
		}
	}
	return best;
}

/**
 * Rank every candidate, keeping the nearest tracked term as the reason.
 *
 * Returns them worst first: the point of the report is what to drop, and the
 * decisions worth reading are at the bottom of the distribution.
 */
export function scoreCandidates(candidates, tracked) {
	return candidates
		.map((c) => ({ ...c, ...nearest(c.vector, tracked) }))
		.map(({ vector: _vector, ...rest }) => rest)
		.toSorted((a, b) => a.score - b.score);
}

/**
 * Split at a threshold. Deliberately not a hard-coded constant: the right cut
 * depends on the model, the language and how broad the tracked set is, so the
 * caller passes one and the report prints the distribution that justifies it.
 */
export function split(scored, threshold) {
	return {
		drop: scored.filter((s) => s.score < threshold),
		keep: scored.filter((s) => s.score >= threshold),
	};
}
