/**
 * AGGREGATOR agent: turns the SQL and note results into one grounded answer
 * for clinic staff. Returns the full text (it does not stream).
 *
 * Either source may be absent. The third argument also accepts a plain string
 * so older callers keep working.
 */

import type { Message } from '../agent';
import { openai } from '../openai';

export type AggregatorSources = {
	sql?: string;
	notes?: string;
};

const SYSTEM_PROMPT = `You answer questions for clinic staff using the patient records provided in the message.

- Base every statement on the provided records.
- Write in plain, everyday language for medical office staff, and state facts directly (for example, "63 patients have hypertension"). Refer to where information came from only in everyday terms such as "the patient records" or "the clinical notes".
- Report counts and numbers exactly as they appear.
- Refer to patients by the name shown on their record.
- When the question asks for patients, list every patient provided in the records.
- When the question asks what the notes say, write a short paragraph summarizing the documented symptoms or events across the notes, naming patients where it helps.
- When the records do not contain the answer, say so plainly and mention what the records do cover.
- When a source is marked unavailable, say that part of the answer could not be retrieved.
- Match the format to the question: one sentence for a single count or fact, a Markdown list for patients, short paragraphs for a summary.
- Keep the answer concise.`;

const HISTORY_TURNS = 6;
const HISTORY_CHARS = 800;

export async function aggregate(
	query: string,
	history: Message[],
	results: string | AggregatorSources,
): Promise<string> {
	const retrieved =
		typeof results === 'string'
			? results
			: [
					results.sql
						? `<sql_results>\n${results.sql}\n</sql_results>`
						: '',
					results.notes
						? `<clinical_notes>\n${results.notes}\n</clinical_notes>`
						: '',
				]
					.filter(Boolean)
					.join('\n\n');

	const recent = history
		.slice(-HISTORY_TURNS)
		.map((h) => `${h.role}: ${h.content.slice(0, HISTORY_CHARS)}`)
		.join('\n');

	const response = await openai.responses.create({
		model: 'gpt-6-sol',
		input: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{
				role: 'user',
				content: `<user_question>
${query}
</user_question>

<conversation_history>
${recent}
</conversation_history>

<retrieved_data>
${retrieved || 'No records were retrieved.'}
</retrieved_data>

Format your response as a markdown list.`,
			},
		],
	});

	return response.output_text;
}
