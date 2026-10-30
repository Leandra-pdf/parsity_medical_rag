/**
 * SQL agent — Week 3. Filter extraction + a dynamic WHERE. Returns TEXT.
 *
 *   1. load the DISTINCT condition names that really exist in the data
 *      ("heart attack" is stored as "Myocardial Infarction")
 *   2. the model reads the question + that list and extracts FILTERS
 *      (structured output) — it never writes SQL
 *   3. buildWhere() turns the filters into a Prisma `where` — parameterized,
 *      so there is nothing to inject and no validator to bolt on
 *   4. run it, hand the rows back as text for the aggregator to summarize
 */

import { zodTextFormat } from 'openai/helpers/zod';

import type { Message } from '../agent';
import { openai } from '../openai';
import { prisma } from '../prisma';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';

const FiltersSchema = z.object({
	conditions: z
		.array(z.string())
		.describe(
			'Condition names the question asks about, copied EXACTLY from the provided list. Empty if none.',
		),
	conditionLogic: z
		.enum(['all', 'any'])
		.describe(
			'all = patient must have every listed condition ("and", "both"); any = at least one ("or", "either").',
		),
	gender: z.enum(['male', 'female']).nullable(),
	minAge: z
		.number()
		.int()
		.nullable()
		.describe('Minimum age in years, if stated.'),
	maxAge: z
		.number()
		.int()
		.nullable()
		.describe('Maximum age in years, if stated.'),
	city: z.string().nullable(),
	alive: z
		.boolean()
		.nullable()
		.describe('true = still alive, false = deceased, null = not stated.'),
});

export type Filters = z.infer<typeof FiltersSchema>;

const yearsAgo = (years: number) => {
	const d = new Date();
	d.setFullYear(d.getFullYear() - years);
	return d;
};

/** Filters -> Prisma where. Only the filters that were actually set are applied. */
export function buildWhere(f: Filters): Prisma.PatientWhereInput {
	const conds = f.conditions.map(
		(display): Prisma.PatientWhereInput => ({
			conditions: { some: { display } },
		}),
	);
	return {
		...(conds.length &&
			(f.conditionLogic === 'any' ? { OR: conds } : { AND: conds })),
		...(f.gender && { gender: f.gender }),
		...(f.city && { city: { equals: f.city, mode: 'insensitive' } }),
		...(f.alive != null && { deathDate: f.alive ? null : { not: null } }),
		...((f.minAge != null || f.maxAge != null) && {
			birthDate: {
				...(f.minAge != null && { lte: yearsAgo(f.minAge) }),
				...(f.maxAge != null && { gt: yearsAgo(f.maxAge + 1) }),
			},
		}),
	};
}

// Up to this many matches are listed with full detail (conditions etc.).
// Bigger result sets are listed compactly (name, age, status) so EVERY match
// still reaches the answer without blowing up the prompt. The shared database
// is ~200 patients, so "summarize their history" keeps its conditions.
const DETAIL_LIMIT = 200;
// Most patients listed in one answer. `total` and `patientIds` still cover
// every match, so counts and the notes search are not affected.
const LIST_LIMIT = 20;

export type SqlResult = {
	/** Text for the aggregator. */
	text: string;
	/** Ids of ALL matching patients (used to scope the notes search). */
	patientIds: string[];
	/** false when no filter was extracted (i.e. "every patient"). */
	filtered: boolean;
	total: number;
};

export async function runSqlDetailed(
	query: string, // tell me about patient wiht a cold under 82
	history: Message[] = [],
): Promise<SqlResult> {
	const conditionRows = await prisma.condition.findMany({
		distinct: ['display'],
		select: { display: true },
		orderBy: { display: 'asc' },
	});
	const known = conditionRows.map((c) => c.display);

	const response = await openai.responses.parse({
		model: 'gpt-6-luna',
		input: [
			{
				role: 'system',
				content: `Extract patient filters from the question. 
				Only set a filter the question actually asks for.\n\n
				Conditions that exist in the data:\n${known.join('\n')}\n\n`,
			},
			...history.map((m) => ({ role: m.role, content: m.content })),
			{ role: 'user', content: query },
		],
		text: { format: zodTextFormat(FiltersSchema, 'filters') },
	}); // get the filters from the question

	const parsedResult = FiltersSchema.safeParse(response.output_parsed);
	if (!parsedResult.success) {
		throw new Error('SQL agent could not extract filters from the question.');
	}
	const parsed = parsedResult.data;

	console.log('parsed', JSON.stringify(parsed, null, 2));

	// The model copies names from the list, but drop anything it invented.
	const filters = {
		...parsed,
		conditions: parsed.conditions.filter((c) => known.includes(c)),
	};

	const where = buildWhere(filters); // function NO AI
	const filtered = Object.keys(where).length > 0;

	const [total, idRows, patients] = await Promise.all([
		prisma.patient.count({ where }),
		prisma.patient.findMany({ where, select: { id: true } }),
		prisma.patient.findMany({
			where,
			take: LIST_LIMIT,
			orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
			select: {
				firstName: true,
				lastName: true,
				gender: true,
				birthDate: true,
				deathDate: true,
				city: true,
				state: true,
				conditions: { select: { display: true, clinicalStatus: true } },
			},
		}),
	]);

	const patientIds = idRows.map((r) => r.id);

	if (total === 0) {
		return { text: 'Matching patients: 0', patientIds, filtered, total };
	}

	const ageOf = (birth: Date | null, death: Date | null) =>
		birth
			? Math.floor(((death ?? new Date()).getTime() - birth.getTime()) / 31557600000)
			: null;

	const detailed = total <= DETAIL_LIMIT;

	const lines = patients.map((p) => {
		const age = ageOf(p.birthDate, p.deathDate);
		const ageText =
			age != null ? `${p.deathDate ? 'age at death' : 'age'} ${age}` : 'age unknown';
		const status = p.deathDate ? 'deceased' : 'alive';

		if (!detailed) return `- ${p.firstName} ${p.lastName} (${ageText}, ${status})`;

		const conditions = [...new Set(p.conditions.map((c) => c.display))]
			.slice(0, 6)
			.join('; ');
		return `- ${p.firstName} ${p.lastName} | ${p.gender ?? 'unknown'} | ${ageText} | ${
			[p.city, p.state].filter(Boolean).join(', ') || 'unknown location'
		} | ${status} | conditions: ${conditions || 'none recorded'}`;
	});

	const text = [
		`Matching patients: ${total}`,
		total > LIST_LIMIT ? `Listing the first ${LIST_LIMIT}:` : 'Patients:',
		...lines,
		...(total > LIST_LIMIT ? [`...and ${total - LIST_LIMIT} more.`] : []),
	].join('\n');

	return { text, patientIds, filtered, total };
}

/** Text-only wrapper, kept for callers that just want the summary string. */
export async function runSql(
	query: string,
	history: Message[] = [],
): Promise<string> {
	return (await runSqlDetailed(query, history)).text;
}
