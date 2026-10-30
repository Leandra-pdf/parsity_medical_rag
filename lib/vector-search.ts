/**
 * Vector search over the clinical notes: two-stage retrieval in one call.
 *
 *   1. embed the query, ask Pinecone for the nearest TOP_K notes (wide, cheap)
 *   2. rerank those candidates against the query, keep TOP_N (narrow, careful)
 *   3. drop anything the reranker scores below MIN_SCORE
 *
 * Returns text for the aggregator, one labelled block per note, so every
 * statement can be tied to the right patient.
 */

import { createEmbedding } from './openai';
import { pinecone } from './pinecone';
import { prisma } from './prisma';

export type VectorSearchOptions = {
	topK?: number; // candidates the cosine search fetches (over-fetch)
	topN?: number; // candidates kept after reranking
	minScore?: number; // rerank score cutoff
	filter?: object; // Pinecone metadata filter, e.g. { patientId: { $eq: id } }
};

const DEFAULT_TOP_K = 30;
const DEFAULT_TOP_N = 8;
// Score cutoff for reranked notes. It starts at 0 (no cutoff) because the
// reranker's real score scale hasn't been measured on this index yet; a 0.3
// cutoff was throwing away every note. Read the logged scores, then raise it
// (or set RERANK_MIN_SCORE in .env) to just below your lowest good match.
const DEFAULT_MIN_SCORE = Number(process.env.RERANK_MIN_SCORE ?? 0);
// One note is ~450 characters on average. This cap only guards outliers, so
// the reranker input and the final prompt stay small.
const MAX_NOTE_CHARS = 1500;

const NO_NOTES = 'No clinical notes matched this search.';
const NOTHING_RELEVANT =
	'Clinical notes were searched, and none were relevant enough to this question.';

// NOTE: this is a single global top-K, not a per-patient search. One embedding
// of the query fetches the nearest `topK` notes across ALL patients allowed by
// the filter, and `topN` of those survive reranking. With a wide filter (say 57
// patients) the surviving notes can come from just a few of them, so patients
// are not guaranteed to be represented. Per-patient retrieval would need one
// filtered search per patient ({ patientId: { $eq: id } }).
export async function searchClinicalNotes(
	query: string,
	options: VectorSearchOptions = {},
): Promise<string> {
	const {
		topK = DEFAULT_TOP_K,
		topN = DEFAULT_TOP_N,
		minScore = DEFAULT_MIN_SCORE,
		filter,
	} = options;

	const embedding = await createEmbedding(query);

	const results = await pinecone.index(process.env.PINECONE_INDEX!).query({
		vector: embedding,
		topK,
		includeMetadata: true,
		...(filter ? { filter } : {}),
	});

	// The reranker reads the note text only; the metadata is used for labels.
	const candidates = results.matches
		.map((m) => ({
			id: m.id,
			text: String(m.metadata?.content ?? '').slice(0, MAX_NOTE_CHARS),
			metadata: m.metadata ?? {},
		}))
		.filter((c) => c.text.length > 0);

	// Return a helpful message if the query and filter find no matches.
	if (candidates.length === 0) return NO_NOTES;

	// Rerank the notes retrieved by Pinecone according to query relevance.
	const reranked = await pinecone.inference.rerank({
		model: 'bge-reranker-v2-m3',
		query,
		documents: candidates.map((c) => c.text),
		topN: Math.min(topN, candidates.length),
		parameters: { truncate: 'END' },
	});

	const kept = reranked.data
		.filter((r) => (r.score ?? 0) >= minScore)
		.map((r) => ({ ...candidates[r.index], score: r.score ?? 0 }));

	console.log('[Search]', {
		fetched: candidates.length,
		reranked: reranked.data.length,
		kept: kept.length,
		minScore,
		scores: reranked.data.map((r) => Number((r.score ?? 0).toFixed(3))),
	});

	if (kept.length === 0) return NOTHING_RELEVANT;

	const names = await patientNames(
		kept.map((k) => String(k.metadata.patientId ?? '')).filter(Boolean),
	);

	return kept
		.map((k, i) => {
			const patientId = String(k.metadata.patientId ?? 'unknown');
			const name = names.get(patientId) ?? 'unknown patient';
			const gender = k.metadata.gender ? String(k.metadata.gender) : 'unknown gender';
			const age = k.metadata.age != null ? `age ${k.metadata.age}` : 'age unknown';
			return `[Note ${i + 1}] Patient: ${name} | ${gender}, ${age} | relevance ${k.score.toFixed(2)}\n${k.text}`;
		})
		.join('\n\n');
}

/** patientId -> "First Last", so each note can be labelled with a real name. */
async function patientNames(ids: string[]): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	if (ids.length === 0) return map;
	try {
		const rows = await prisma.patient.findMany({
			where: { id: { in: [...new Set(ids)] } },
			select: { id: true, firstName: true, lastName: true },
		});
		for (const r of rows) map.set(r.id, `${r.firstName} ${r.lastName}`);
	} catch (error) {
		// Labels are a nicety. The notes are still returned without names.
		console.error('[Search] Patient name lookup failed:', error);
	}
	return map;
}
