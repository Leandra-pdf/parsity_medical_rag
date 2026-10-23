/**
 * Vector search over the clinical notes — Week 2, built together in class.
 *
 * The shape we're building, two-stage retrieval in one call:
 *   1. embed the query, ask Pinecone for the nearest topK notes (wide, cheap)
 *   2. rerank those candidates against the query, keep topN (narrow, careful)
 *
 * Returns both lists so you can log them side by side and SEE what reranking
 * changed on a given query.
 */

import type { SearchResult } from './pinecone';
import { createEmbedding } from './openai';
import { pinecone } from './pinecone';

export type VectorSearchOptions = {
	topK?: number; // candidates the cosine search fetches
	topN?: number; // candidates kept after reranking
	filter?: object; // Optional metadata filters to narrow search results by fields such as gender or age.
	// accepts a Pinecone filter directly
};

export async function searchClinicalNotes(
    query: string,
    options: VectorSearchOptions = {},
): Promise<string> {
    // Convert the search query into an embedding vector.
    const embedding = await createEmbedding(query);

    // Pass options.filter directly to Pinecone.
    // If no filter is provided, Pinecone performs a normal vector search.
    const results = await pinecone
        .index(process.env.PINECONE_INDEX!)
        .query({
            vector: embedding, //query represented as 1536 vector
            topK: options.topK ?? 10, // Use the provided topK value, or default to 10 results if none is provided.
            includeMetadata: true,  // content we got race / gender / age / etc.
            ...(options.filter ? { filter: options.filter } : {}),
        });

    const matchesWithScores = results.matches.map((match) => ({
        id: match.id,
        score: match.score,
        content: match.metadata?.content as string,
        metadata: match.metadata,
    }));

    // Prepare the retrieved notes and metadata for the reranking model.
    const docs = results.matches.map(
        (match) =>
            `${match.metadata?.content} metadata: ${JSON.stringify(match.metadata)}`,
    );

    // Return a helpful message if the query and filter find no matches.
    if (docs.length === 0) {
        return 'No matching clinical notes were found.';
    }

    // Rerank the notes retrieved by Pinecone according to query relevance.
    const reranked = await pinecone.inference.rerank({
        model: 'bge-reranker-v2-m3',
        query: query,
        documents: docs,
        topN: options.topN ?? 10, // Default to keeping up to 10 reranked results
    });

    // Log the reranking output for debugging.
    console.log(JSON.stringify(reranked.data, null, 2));

    // Return the reranked note text.
    return reranked.data.map((result) => result.document?.text).join('\n');
}