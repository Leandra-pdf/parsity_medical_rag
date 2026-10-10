/**
 * Vectorize the notes — Week 1.
 *
 * Postgres is the system of record. Pinecone is a DERIVED index built from it:
 * read every clinical note, shape it into a `MedicalChunk`, and hand the chunks
 * to `upsertChunks()` (lib/pinecone.ts), which embeds AND upserts them, 100 at
 * a time, with retries.
 *
 *   npm run vectorize -- --limit 5     # prove it works, then check the Pinecone console
 *   npm run vectorize                  # all ~21,000 notes (15–25 min, a few cents)
 *
 * Re-running is safe: each vector's id is the note's id, so a second run
 * overwrites instead of duplicating.
 *
 * Needs: DATABASE_URL, OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX.
 */

import 'dotenv/config';
import { createPrisma } from '../lib/prisma';
import { ensureIndexExists, upsertChunks, MedicalChunk } from '../lib/pinecone';

// The long read over ~21k notes times out on Neon's POOLED host, so prefer the
// direct (non-pooler) connection. Same credentials either way.
const directUrl =
	process.env.DIRECT_URL ??
	process.env.DATABASE_URL?.replace('-pooler.', '.');
const prisma = createPrisma(directUrl);

// `--limit 5` → 5. No flag → undefined (all notes).
const limitIdx = process.argv.indexOf('--limit');
const limit =
	limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1], 10) : undefined;

// Pinecone range filters need numbers, so store age (at death, or today).
function ageAt(birth: Date | null, death: Date | null): number {
	if (!birth) return -1;
	return Math.floor(
		((death ?? new Date()).getTime() - birth.getTime()) / 31_557_600_000,
	);
}

async function main() {
	await ensureIndexExists();

	const notes = await prisma.note.findMany({
		take: limit,
		include: { patient: true },
		orderBy: { id: 'asc' },
	});
	console.log(
		`Read ${notes.length} notes from Postgres. Embedding + upserting…`,
	);

	const chunks: MedicalChunk[] = notes.map((note) => ({
		id: note.id,
		content: note.content, // the only part that gets embedded
		metadata: {
			patientId: note.patientId,
			dob: note.patient.birthDate?.toISOString().slice(0, 10) ?? 'unknown',
			gender: note.patient.gender ?? 'unknown',
			isAlive: note.patient.deathDate === null,
			age: ageAt(note.patient.birthDate, note.patient.deathDate),
			ethnicity: note.patient.ethnicity ?? 'unknown',
			race: note.patient.race ?? 'unknown',
		},
	}));

	const total = await upsertChunks(chunks);
	console.log(`Done. Upserted ${total} note vectors.`);
}

main()
	.catch((err) => {
		console.error(err);
		process.exit(1);
	})
	.finally(() => prisma.$disconnect());
