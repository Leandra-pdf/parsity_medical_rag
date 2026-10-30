// app/api/chat/route.ts
import { openai } from '@/lib/openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { searchClinicalNotes } from '@/lib/vector-search';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { select, type Selection } from '@/lib/agents/selector';
import { runSql, runSqlDetailed } from '@/lib/agents/sql';
import { checkSlot, isPastLocal, listAppointments } from '@/lib/calendar';
import { aggregate, type AggregatorSources } from '@/lib/agents/aggregator';
import {
	getPatientProfile,
	isFullName,
	lookupFailureMessage,
	resolvePatient,
	type PatientMatch,
} from '@/lib/patients';

const ChatRequestSchema = z.object({
	query: z.string().min(1),
	messages: z
		.array(
			z.object({
				role: z.enum(['user', 'assistant']),
				content: z.string(),
			}),
		)
		.default([]),
});

type ChatMessage = z.infer<typeof ChatRequestSchema>['messages'][number];

const AppointmentInfoSchema = z.object({
	patientName: z
		.string()
		.min(1)
		.nullable()
		.describe(
			"The patient's name exactly as the user wrote it, taken from the question or earlier turns. Null when no name appears.",
		),
	patientDob: z
		.string()
		.nullable()
		.describe(
			'Date of birth as YYYY-MM-DD when the user gives one, otherwise null.',
		),
	date: z.iso
		.date()
		.nullable()
		.describe('Appointment date as YYYY-MM-DD, or null if unresolved.'),
	time: z
		.string()
		.regex(/^([01]\d|2[0-3]):[0-5]\d$/)
		.nullable()
		.describe(
			'Appointment time as HH:MM in 24-hour format, or null if unknown. No seconds.',
		),
	reason: z
		.string()
		.nullable()
		.describe('Appointment reason, or null if not provided.'),
});

/** Cancel / reschedule: date and time are the EXISTING appointment's. */
const ChangeInfoSchema = AppointmentInfoSchema.omit({ reason: true }).extend({
	date: AppointmentInfoSchema.shape.date.describe(
		'Date of the EXISTING appointment as YYYY-MM-DD, or null if unresolved.',
	),
	time: AppointmentInfoSchema.shape.time.describe(
		'Time of the EXISTING appointment as HH:MM in 24-hour format, or null if unknown.',
	),
	newDate: AppointmentInfoSchema.shape.date.describe(
		'Reschedule only: the NEW date as YYYY-MM-DD, or null if not given.',
	),
	newTime: AppointmentInfoSchema.shape.time.describe(
		'Reschedule only: the NEW time as HH:MM in 24-hour format, or null if not given.',
	),
});

const CAL_TIME_ZONE = process.env.CAL_TIME_ZONE;

/** Today's date and weekday in the clinic's time zone (not UTC). */
function todayInClinic() {
	const now = new Date();
	return {
		date: new Intl.DateTimeFormat('en-CA', {
			timeZone: CAL_TIME_ZONE,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).format(now), // YYYY-MM-DD
		weekday: new Intl.DateTimeFormat('en-US', {
			timeZone: CAL_TIME_ZONE,
			weekday: 'long',
		}).format(now),
	};
}

/** "2026-11-02" -> "Monday, November 2, 2026" */
function friendlyDate(date: string): string {
	const [year, month, day] = date.split('-').map(Number);
	return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC',
	});
}

/** "14:00" -> "2:00 PM" */
function friendlyTime(time: string): string {
	const [hour, minute] = time.split(':').map(Number);
	return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}

/** Turn a thrown error into a status and a message that is safe to show. */
function friendlyError(error: unknown): { status: number; message: string } {
	const e = error as { status?: number; code?: string } | null;
	if (e?.status === 429) {
		return {
			status: 429,
			message: 'The service is busy right now. Please try again in a moment.',
		};
	}
	if (e?.code === 'context_length_exceeded') {
		return {
			status: 413,
			message:
				'That question pulled in more data than I can process at once. Try narrowing it, for example by adding a condition, age range or patient name.',
		};
	}
	return {
		status: 500,
		message: 'Something went wrong while answering. Please try again.',
	};
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Await a promise without throwing, so one failed source cannot sink the other. */
async function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
	try {
		return { ok: true, value: await promise };
	} catch (error) {
		return { ok: false, error };
	}
}

/**
 * The chat pipeline. This route is the orchestrator:
 *
 *   1. validate the request
 *   2. the selector picks the route         (lib/agents/selector.ts)
 *   3. reject / schedule / search the records
 *   4. the aggregator writes the answer     (lib/agents/aggregator.ts)
 *
 * Returns JSON: { message, schedulingAction? } or { error }.
 */
export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
	}

	const parsedBody = ChatRequestSchema.safeParse(body);
	if (!parsedBody.success) {
		return NextResponse.json(
			{ error: 'Invalid request. A non-empty "query" is required.' },
			{ status: 400 },
		);
	}
	const { query, messages } = parsedBody.data;

	try {
		const selection = await select(query, messages);

		console.log(`[ROUTER] Query: ${query}`);
		console.log(`[ROUTER] Actions: ${selection.actions.join(' + ')}`);
		console.log(`[ROUTER] Reason: ${selection.reason}`);

		if (selection.actions.includes('reject')) {
			return NextResponse.json({
				message:
					'I can help with questions about patient records and with scheduling appointments.',
			});
		}

		if (selection.actions.includes('list_appointments')) {
			return await handleList(selection);
		}

		if (selection.actions.includes('cancel_appointment')) {
			return await handleChange('cancel', query, messages);
		}

		if (selection.actions.includes('reschedule_appointment')) {
			return await handleChange('reschedule', query, messages);
		}

		if (selection.actions.includes('schedule_appointment')) {
			return await handleScheduling(query, messages);
		}

		return await answerFromRecords(query, messages, selection);
	} catch (error) {
		console.error('Chat error:', error);
		const { status, message } = friendlyError(error);
		return NextResponse.json({ error: message }, { status });
	}
}

/**
 * Scheduling: get a full name, confirm the patient exists, then (and only
 * then) hand the UI a schedulingAction so it can show the confirm card.
 * Once the patient is known, replies just use their name.
 */
async function handleScheduling(query: string, messages: ChatMessage[]) {
	const today = todayInClinic();

	const response = await openai.responses.parse({
		model: 'gpt-6-luna',
		input: [
			{
				role: 'system',
				content: `Extract the patient name, date, time, and reason to schedule an appointment.
Today is ${today.weekday}, ${today.date} (${CAL_TIME_ZONE}). Resolve relative dates such as "tomorrow" or "next Tuesday" from today into YYYY-MM-DD.
Times are HH:MM in 24-hour format.
Fill a field only with information the user provided. Use null for every other field. ONLY USE THE INFORMATION PROVIDED.`,
			},
			{
				role: 'user',
				content: `Query: ${query}
Previous messages: ${JSON.stringify(messages.slice(-5))}`,
			},
		],
		text: {
			format: zodTextFormat(AppointmentInfoSchema, 'appointment_info'),
		},
	});

	const info = AppointmentInfoSchema.safeParse(response.output_parsed);
	if (!info.success) {
		console.error('[Schedule] Could not parse appointment details:', info.error);
		return NextResponse.json({
			message:
				"I couldn't read the appointment details. Please tell me the patient's full name, the date and the time.",
		});
	}
	const { patientName, patientDob, date, time, reason } = info.data;

	// 1. A full name comes first. A missing or partial name is asked for
	//    without touching the database.
	if (!patientName) {
		return NextResponse.json({
			message:
				"Who is this appointment for? Please give the patient's full name (first and last).",
		});
	}
	if (!isFullName(patientName)) {
		return NextResponse.json({
			message: `I need the patient's full name (first and last) to book this. What is **${patientName}**'s last name?`,
		});
	}

	// 2. With a full name, confirm the patient is real.
	const match = await resolvePatient(patientName, patientDob);
	if (match.status !== 'found') {
		return NextResponse.json({
			message: lookupFailureMessage(match, patientName),
		});
	}
	const patient = match.patient;
	const fullName = `${patient.firstName} ${patient.lastName}`;
	if (patient.deathDate) {
		return NextResponse.json({
			message: `**${fullName}** is deceased, so I can't book an appointment for them.`,
		});
	}

	// 3. Then the date and time.
	if (!date || !time) {
		return NextResponse.json({
			message: `What date and time would you like for **${fullName}**?`,
		});
	}
	if (date < today.date) {
		return NextResponse.json({
			message: `${friendlyDate(date)} has already passed. Which upcoming date would you like?`,
		});
	}

	const slot = await checkSlot(`${date}T${time}:00`);
	if (!slot.success) {
		return NextResponse.json({
			message: `${slot.error} Which other date and time would you like for **${fullName}**?`,
		});
	}

	return NextResponse.json({
		message: `Please review the appointment for **${fullName}** below and confirm.`,
		schedulingAction: {
			patientId: patient.id,
			patientName: fullName,
			date,
			time,
			reason,
		},
	});
}

/**
 * Cancel / reschedule: the appointment must already exist for this patient at
 * the stated date and time. Only then does the UI get a schedulingAction to
 * show its confirm card.
 */
async function handleChange(
	kind: 'cancel' | 'reschedule',
	query: string,
	messages: ChatMessage[],
) {
	const today = todayInClinic();
	const verb = kind === 'cancel' ? 'cancel' : 'reschedule';

	const response = await openai.responses.parse({
		model: 'gpt-6-luna',
		input: [
			{
				role: 'system',
				content: `Extract the patient name and the date and time of their EXISTING appointment, which the user wants to ${verb}.${
					kind === 'reschedule'
						? ' Also extract the NEW date and time they want to move it to.'
						: ''
				}
Today is ${today.weekday}, ${today.date} (${CAL_TIME_ZONE}). Resolve relative dates such as "tomorrow" or "next Tuesday" from today into YYYY-MM-DD.
Times are HH:MM in 24-hour format.
Fill a field only with information the user provided. Use null for every other field. ONLY USE THE INFORMATION PROVIDED.`,
			},
			{
				role: 'user',
				content: `Query: ${query}
Previous messages: ${JSON.stringify(messages.slice(-5))}`,
			},
		],
		text: { format: zodTextFormat(ChangeInfoSchema, 'appointment_change') },
	});

	const info = ChangeInfoSchema.safeParse(response.output_parsed);
	if (!info.success) {
		console.error('[Schedule] Could not parse appointment details:', info.error);
		return NextResponse.json({
			message: `I couldn't read the appointment details. Please tell me the patient's full name and the date and time of the appointment to ${verb}.`,
		});
	}
	const { patientName, patientDob, date, time, newDate, newTime } = info.data;

	if (!patientName) {
		return NextResponse.json({
			message: `Whose appointment would you like to ${verb}? Please give the patient's full name (first and last).`,
		});
	}
	if (!isFullName(patientName)) {
		return NextResponse.json({
			message: `I need the patient's full name (first and last). What is **${patientName}**'s last name?`,
		});
	}

	const match = await resolvePatient(patientName, patientDob);
	if (match.status !== 'found') {
		return NextResponse.json({
			message: lookupFailureMessage(match, patientName),
		});
	}
	const patient = match.patient;
	const fullName = `${patient.firstName} ${patient.lastName}`;

	// Deceased patients can't be moved to a new time (cancelling is still fine).
	if (kind === 'reschedule' && patient.deathDate) {
		return NextResponse.json({
			message: `**${fullName}** is deceased, so I can't reschedule an appointment for them.`,
		});
	}

	// A new time is needed before we go looking for the appointment to move.
	if (kind === 'reschedule') {
		if (!newDate || !newTime) {
			return NextResponse.json({
				message: `What new date and time would you like for **${fullName}**?`,
			});
		}
		if (newDate < today.date) {
			return NextResponse.json({
				message: `${friendlyDate(newDate)} has already passed. Which upcoming date would you like?`,
			});
		}
	}

	// Past appointments can't be changed.
	if (
		(date && time && isPastLocal(`${date}T${time}:00`)) ||
		(date && !time && date < today.date)
	) {
		return NextResponse.json({
			message: `That appointment has already passed, so it can't be ${kind === 'cancel' ? 'cancelled' : 'rescheduled'}.`,
		});
	}

	// Find the appointment from whatever the user gave: nothing, a date, or a
	// date and time. With several matches, the next one (soonest) is used.
	const listed = await listAppointments(fullName);
	if (!listed.success) {
		return NextResponse.json({ message: listed.error });
	}
	const label = (a: { date: string; time: string }) => `**${friendlyDate(a.date)} at ${friendlyTime(a.time)}**`;
	const candidates = listed.appointments.filter(
		(a) => (!date || a.date === date) && (!time || a.time === time),
	);

	if (candidates.length === 0) {
		const asked = [
			date && `on ${friendlyDate(date)}`,
			time && `at ${friendlyTime(time)}`,
		]
			.filter(Boolean)
			.join(' ');
		return NextResponse.json({
			message: `I couldn't find an upcoming appointment for **${fullName}**${asked ? ` ${asked}` : ''}, so there's nothing to ${verb}.${
				listed.appointments.length
					? ` Their upcoming appointments are:\n${listed.appointments.map((a) => `- ${label(a)}`).join('\n')}`
					: ''
			}`,
		});
	}
	const existing = candidates[0];

	if (
		kind === 'reschedule' &&
		newDate === existing.date &&
		newTime === existing.time
	) {
		return NextResponse.json({
			message: `**${fullName}** is already booked for ${label(existing)}. Which new time would you like?`,
		});
	}

	if (kind === 'reschedule') {
		const slot = await checkSlot(`${newDate}T${newTime}:00`, {
			ignoreBookingId: existing.bookingId,
		});
		if (!slot.success) {
			return NextResponse.json({
				message: `${slot.error} Which other date and time would you like for **${fullName}**?`,
			});
		}
	}

	return NextResponse.json({
		message: `Please review the ${verb === 'cancel' ? 'cancellation' : 'new time'} for **${fullName}**${candidates.length > 1 ? `'s next appointment (${label(existing)})` : ''} below and confirm.`,
		schedulingAction: {
			kind,
			patientId: patient.id,
			patientName: fullName,
			date: existing.date,
			time: existing.time,
			...(kind === 'reschedule' ? { newDate, newTime } : {}),
		},
	});
}

/** List up to 5 upcoming appointments for one patient. */
async function handleList(selection: Selection) {
	const name = selection.patientName;
	if (!name) {
		return NextResponse.json({
			message:
				"Whose appointments would you like to see? Please give the patient's full name (first and last).",
		});
	}
	if (!isFullName(name)) {
		return NextResponse.json({
			message: `I need the patient's full name (first and last). What is **${name}**'s last name?`,
		});
	}
	const match = await resolvePatient(name, selection.patientDob);
	if (match.status !== 'found') {
		return NextResponse.json({ message: lookupFailureMessage(match, name) });
	}
	const fullName = `${match.patient.firstName} ${match.patient.lastName}`;

	const listed = await listAppointments(fullName);
	if (!listed.success) {
		return NextResponse.json({ message: listed.error });
	}
	if (listed.appointments.length === 0) {
		return NextResponse.json({
			message: `**${fullName}** has no upcoming appointments.`,
		});
	}

	const shown = listed.appointments.slice(0, 5);
	const more = listed.appointments.length - shown.length;
	return NextResponse.json({
		message: `Upcoming appointments for **${fullName}**:\n${shown
			.map((a) => `- **${friendlyDate(a.date)} at ${friendlyTime(a.time)}**`)
			.join('\n')}${more > 0 ? `\n\n…and ${more} more.` : ''}`,
	});
}

/**
 * Search the records, then hand everything to the aggregator.
 *
 *  - one named patient: that patient's profile + only that patient's notes
 *  - SQL + notes together: SQL decides WHICH patients match, and the notes are
 *    searched within exactly those patients (a real join, not two unrelated lists)
 *  - otherwise: whichever single source the selector chose
 */
async function answerFromRecords(
	query: string,
	messages: ChatMessage[],
	selection: Selection,
) {
	const wantsSql = selection.actions.includes('sql_search');
	const wantsNotes = selection.actions.includes('vector_search');
	// The selector's standalone notes query leaves out structured filters
	// (age, alive, city) that would only add noise to the embedding.
	const notesQuery = selection.searchQuery ?? query;

	// A question about one named patient is scoped to that patient.
	let patient: PatientMatch | null = null;
	if (selection.patientName) {
		if (!isFullName(selection.patientName)) {
			return NextResponse.json({
				message: `Which patient do you mean by **${selection.patientName}**? Please give their full name (first and last).`,
			});
		}
		const match = await resolvePatient(selection.patientName, selection.patientDob);
		if (match.status !== 'found') {
			return NextResponse.json({
				message: lookupFailureMessage(match, selection.patientName),
			});
		}
		patient = match.patient;
	}

	let sqlOut: Outcome<string> | null = null;
	let notesOut: Outcome<string> | null = null;

	if (patient) {
		[sqlOut, notesOut] = await Promise.all([
			wantsSql ? settle(getPatientProfile(patient.id)) : null,
			wantsNotes
				? settle(
						searchClinicalNotes(notesQuery, {
							filter: { patientId: { $eq: patient.id } },
						}),
					)
				: null,
		]);
	} else if (wantsSql && wantsNotes) {
		const sql = await settle(runSqlDetailed(query, messages));
		if (!sql.ok) {
			sqlOut = sql;
			notesOut = await settle(searchClinicalNotes(notesQuery, { topK: 60, topN: 20 }));
		} else {
			sqlOut = { ok: true, value: sql.value.text };
			const { patientIds, filtered } = sql.value;
			if (filtered && patientIds.length === 0) {
				notesOut = {
					ok: true,
					value: 'No patients matched the filters, so no notes were searched.',
				};
			} else {
				notesOut = await settle(
					searchClinicalNotes(notesQuery, {
						topK: 60,
						topN: 20,
						...(filtered
							? { filter: { patientId: { $in: patientIds } } }
							: {}),
					}),
				);
			}
		}
	} else {
		[sqlOut, notesOut] = await Promise.all([
			wantsSql ? settle(runSql(query, messages)) : null,
			wantsNotes ? settle(searchClinicalNotes(notesQuery)) : null,
		]);
	}

	let failed = 0;
	const collect = (
		out: Outcome<string> | null,
		label: string,
		unavailable: string,
	): string | undefined => {
		if (!out) return undefined;
		if (out.ok) return out.value;
		failed++;
		console.error(`[${label}] failed:`, out.error);
		return unavailable;
	};

	const sources: AggregatorSources = {
		sql: collect(
			sqlOut,
			'SQL',
			'Status: the structured database search was unavailable for this question.',
		),
		notes: collect(
			notesOut,
			'Notes',
			'Status: the clinical notes search was unavailable for this question.',
		),
	};

	const requested = Number(sqlOut !== null) + Number(notesOut !== null);
	if (requested > 0 && failed === requested) {
		return NextResponse.json(
			{
				error:
					"I couldn't reach the patient records right now. Please try again in a moment.",
			},
			{ status: 502 },
		);
	}

	const message = await aggregate(query, messages, sources);
	return NextResponse.json({ message });
}
