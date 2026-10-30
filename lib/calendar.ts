/**
 * Cal.com integration (API v2).
 *
 * Creates bookings for the human-in-the-loop scheduling flow. Failures come
 * back with a `code` so the API route can answer with the right HTTP status
 * and the UI can show a message that matches what actually went wrong.
 */

const CAL_BOOKINGS_URL = 'https://api.cal.com/v2/bookings';
const CAL_API_VERSION = '2026-02-25';

export type ScheduleErrorCode =
	| 'unavailable' // outside availability, or the slot is already booked
	| 'invalid' // Cal.com rejected the request data
	| 'not_found' // no matching appointment to cancel or reschedule
	| 'past' // the date/time has already passed
	| 'conflict' // overlaps another scheduled meeting
	| 'config' // missing or rejected credentials / settings
	| 'rate_limited'
	| 'upstream'; // Cal.com or the network failed

export interface ScheduleRequest {
	patientName: string;
	/** Local wall-clock time in CAL_TIME_ZONE: YYYY-MM-DDTHH:mm[:ss]. */
	dateTime: string;
	patientId?: string;
	patientEmail?: string;
	notes?: string | null;
}

export interface ScheduleResult {
	success: boolean;
	bookingId?: string;
	bookingUrl?: string;
	error?: string;
	code?: ScheduleErrorCode;
}

const getTimeZone = () => process.env.CAL_TIME_ZONE || 'America/New_York';

/** Current wall-clock time in CAL_TIME_ZONE as YYYY-MM-DDTHH:mm. */
export function nowLocal(): string {
	const v: Record<string, string> = {};
	for (const part of new Intl.DateTimeFormat('en-CA', {
		timeZone: getTimeZone(),
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(new Date())) {
		v[part.type] = part.value;
	}
	return `${v.year}-${v.month}-${v.day}T${v.hour}:${v.minute}`;
}

/** True when a local YYYY-MM-DDTHH:mm[:ss] is not in the future. */
export function isPastLocal(dateTime: string): boolean {
	return dateTime.slice(0, 16) <= nowLocal();
}

/** Check if Cal.com is configured. */
export function isCalConfigured(): boolean {
	return Boolean(process.env.CAL_API_KEY && process.env.CAL_EVENT_TYPE_ID);
}

/** Converts a local appointment time into a UTC ISO timestamp. */
function localDateTimeToUtc(dateTime: string, timeZone: string): string {
	const match = dateTime.match(
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
	);
	if (!match) {
		throw new Error(`Invalid appointment date/time: ${dateTime}`);
	}

	const [, year, month, day, hour, minute, second = '00'] = match;

	const targetUtc = Date.UTC(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour),
		Number(minute),
		Number(second),
	);

	const formatter = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
	});

	let resultUtc = targetUtc;

	for (let i = 0; i < 4; i++) {
		const values: Record<string, string> = {};
		for (const part of formatter.formatToParts(new Date(resultUtc))) {
			values[part.type] = part.value;
		}

		const representedUtc = Date.UTC(
			Number(values.year),
			Number(values.month) - 1,
			Number(values.day),
			Number(values.hour),
			Number(values.minute),
			Number(values.second),
		);

		const difference = targetUtc - representedUtc;
		if (difference === 0) break;
		resultUtc += difference;
	}

	return new Date(resultUtc).toISOString();
}

/** Map a failed Cal.com response to one of our error codes. */
function classifyFailure(status: number, result: any): ScheduleErrorCode {
	if (result?.error?.code === 'ConflictException' || status === 409) {
		return 'unavailable';
	}
	if (status === 400 || status === 422) return 'invalid';
	if (status === 401 || status === 403) return 'config';
	if (status === 429) return 'rate_limited';
	return 'upstream';
}

/** HTTP status the API routes answer with for each error code. */
export const STATUS_FOR_CODE: Record<ScheduleErrorCode, number> = {
	unavailable: 409,
	invalid: 400,
	not_found: 404,
	past: 400,
	conflict: 409,
	config: 503,
	rate_limited: 429,
	upstream: 502,
};

const FAILURE_MESSAGES: Record<ScheduleErrorCode, string> = {
	unavailable:
		'That time is not available. It is either outside the calendar’s availability or already booked.',
	invalid: 'Cal.com could not accept those appointment details.',
	not_found: 'No matching appointment was found for that patient, date and time.',
	past: 'That date and time has already passed.',
	conflict: 'That time overlaps another scheduled meeting.',
	config: 'The scheduling service rejected our credentials or settings.',
	rate_limited: 'Too many scheduling requests were made. Please wait a moment.',
	upstream: 'The scheduling service had a problem. Please try again shortly.',
};

/** Create a booking in Cal.com. */
export async function scheduleAppointment(
	request: ScheduleRequest,
): Promise<ScheduleResult> {
	const apiKey = process.env.CAL_API_KEY;
	const eventTypeId = Number(process.env.CAL_EVENT_TYPE_ID);
	const attendeeEmail = process.env.CAL_TEST_ATTENDEE_EMAIL;
	const timeZone = getTimeZone();

	if (
		!apiKey ||
		!Number.isInteger(eventTypeId) ||
		eventTypeId <= 0 ||
		!attendeeEmail
	) {
		console.error(
			'[Cal.com] Missing CAL_API_KEY, CAL_EVENT_TYPE_ID or CAL_TEST_ATTENDEE_EMAIL.',
		);
		return { success: false, code: 'config', error: FAILURE_MESSAGES.config };
	}

	let startUtc: string;
	try {
		startUtc = localDateTimeToUtc(request.dateTime, timeZone);
	} catch (error) {
		console.error('[Cal.com] Bad date/time:', error);
		return { success: false, code: 'invalid', error: FAILURE_MESSAGES.invalid };
	}

	// Cal.com metadata values are strings.
	const metadata: Record<string, string> = {};
	if (request.patientId) metadata.patientId = request.patientId;
	if (request.notes) metadata.reason = request.notes.slice(0, 500);

	console.log('[Cal.com] Booking:', {
		eventTypeId,
		localTime: request.dateTime,
		startUtc,
		timeZone,
	});

	try {
		const response = await fetch(CAL_BOOKINGS_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				'cal-api-version': CAL_API_VERSION,
			},
			body: JSON.stringify({
				start: startUtc,
				eventTypeId,
				attendee: {
					name: request.patientName,
					email: request.patientEmail ?? attendeeEmail,
					timeZone,
					language: 'en',
				},
				...(Object.keys(metadata).length ? { metadata } : {}),
			}),
		});

		const responseText = await response.text();
		let result: any;
		try {
			result = JSON.parse(responseText);
		} catch {
			result = { rawResponse: responseText };
		}

		if (!response.ok) {
			const code = classifyFailure(response.status, result);
			console.error('[Cal.com] Booking failed:', {
				status: response.status,
				code,
				body: result,
			});
			return { success: false, code, error: FAILURE_MESSAGES[code] };
		}

		const booking = result?.data;
		if (!booking?.uid && !booking?.id) {
			console.error('[Cal.com] Response missing booking ID:', result);
			return { success: false, code: 'upstream', error: FAILURE_MESSAGES.upstream };
		}

		const scheduleResult: ScheduleResult = {
			success: true,
			bookingId: String(booking.uid ?? booking.id),
			bookingUrl:
				typeof booking.location === 'string' &&
				booking.location.startsWith('https://')
					? booking.location
					: undefined,
		};
		console.log('[Cal.com] Booked:', scheduleResult);
		return scheduleResult;
	} catch (error) {
		console.error('[Cal.com] Request threw:', error);
		return { success: false, code: 'upstream', error: FAILURE_MESSAGES.upstream };
	}
}

const calFailure = (code: ScheduleErrorCode): ScheduleResult => ({
	success: false,
	code,
	error: FAILURE_MESSAGES[code],
});

/** Call Cal.com and parse the JSON body; never throws on a non-2xx status. */
async function calRequest(
	url: string,
	method: 'GET' | 'POST',
	body?: Record<string, unknown>,
	apiVersion: string = CAL_API_VERSION,
): Promise<{ ok: boolean; status: number; result: any }> {
	const response = await fetch(url, {
		method,
		headers: {
			Authorization: `Bearer ${process.env.CAL_API_KEY}`,
			'Content-Type': 'application/json',
			'cal-api-version': apiVersion,
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const text = await response.text();
	let result: any;
	try {
		result = JSON.parse(text);
	} catch {
		result = { rawResponse: text };
	}
	return { ok: response.ok, status: response.status, result };
}

/**
 * Find the upcoming appointment for this patient at exactly this local
 * date/time. Success carries the Cal.com bookingId; `not_found` means there is
 * nothing to cancel or reschedule.
 */
export async function findAppointment(request: {
	patientName: string;
	dateTime: string;
}): Promise<ScheduleResult> {
	if (!isCalConfigured()) return calFailure('config');

	let startUtc: string;
	try {
		startUtc = localDateTimeToUtc(request.dateTime, getTimeZone());
	} catch (error) {
		console.error('[Cal.com] Bad date/time:', error);
		return calFailure('invalid');
	}

	const startMs = new Date(startUtc).getTime();
	const params = new URLSearchParams({
		status: 'upcoming',
		afterStart: new Date(startMs - 60_000).toISOString(),
		beforeEnd: new Date(startMs + 24 * 60 * 60_000).toISOString(),
	});

	try {
		const { ok, status, result } = await calRequest(
			`${CAL_BOOKINGS_URL}?${params}`,
			'GET',
		);
		if (!ok) {
			const code = classifyFailure(status, result);
			console.error('[Cal.com] Lookup failed:', { status, code, body: result });
			return calFailure(code);
		}

		const bookings: any[] = Array.isArray(result?.data) ? result.data : [];
		const wanted = request.patientName.trim().toLowerCase();
		const match = bookings.find(
			(b) =>
				new Date(b.start).getTime() === startMs &&
				(!Array.isArray(b.attendees) ||
					b.attendees.some(
						(a: any) => String(a?.name ?? '').trim().toLowerCase() === wanted,
					)),
		);
		if (!match?.uid) return calFailure('not_found');

		return { success: true, bookingId: String(match.uid) };
	} catch (error) {
		console.error('[Cal.com] Lookup threw:', error);
		return calFailure('upstream');
	}
}

const listFailure = (code: ScheduleErrorCode) => ({
	success: false as const,
	code,
	error: FAILURE_MESSAGES[code],
});

export type PatientAppointment = {
	bookingId: string;
	/** Local date and time in CAL_TIME_ZONE: YYYY-MM-DD and HH:mm. */
	date: string;
	time: string;
};

/** Every upcoming appointment booked under this patient's name, soonest first. */
export async function listAppointments(
	patientName: string,
): Promise<
	| { success: true; appointments: PatientAppointment[] }
	| { success: false; code: ScheduleErrorCode; error: string }
> {
	if (!isCalConfigured()) return listFailure('config');

	const timeZone = getTimeZone();
	const formatter = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	});

	try {
		const { ok, status, result } = await calRequest(
			`${CAL_BOOKINGS_URL}?${new URLSearchParams({ status: 'upcoming', take: '100' })}`,
			'GET',
		);
		if (!ok) {
			const code = classifyFailure(status, result);
			console.error('[Cal.com] List failed:', { status, code, body: result });
			return listFailure(code);
		}

		const wanted = patientName.trim().toLowerCase();
		const bookings: any[] = Array.isArray(result?.data) ? result.data : [];
		console.log('[Cal.com] Upcoming bookings:', bookings.length, 'attendees:', bookings.map((b) => b?.attendees?.map((a: any) => a?.name)));
		const appointments = bookings
			.filter(
				(b) =>
					b?.uid &&
					new Date(b.start).getTime() > Date.now() &&
					!Number.isNaN(new Date(b.start).getTime()) &&
					Array.isArray(b.attendees) &&
					b.attendees.some(
						(a: any) => String(a?.name ?? '').trim().toLowerCase() === wanted,
					),
			)
			.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
			.map((b) => {
				const v: Record<string, string> = {};
				for (const part of formatter.formatToParts(new Date(b.start))) {
					v[part.type] = part.value;
				}
				return {
					bookingId: String(b.uid),
					date: `${v.year}-${v.month}-${v.day}`,
					time: `${v.hour}:${v.minute}`,
				};
			});

		return { success: true, appointments };
	} catch (error) {
		console.error('[Cal.com] List threw:', error);
		return listFailure('upstream');
	}
}

const CAL_SLOTS_URL = 'https://api.cal.com/v2/slots';
const CAL_SLOTS_API_VERSION = '2024-09-04';
const DEFAULT_MEETING_MINUTES = 30;

/**
 * Check that a local date/time can be booked: in the future, not overlapping
 * another meeting, and inside the calendar's availability. Pass
 * `ignoreBookingId` when moving a meeting so it does not conflict with itself.
 * If Cal.com cannot be reached for the check, it passes and Cal.com's own
 * rejection at booking time is the backstop.
 */
export async function checkSlot(
	dateTime: string,
	options: { ignoreBookingId?: string } = {},
): Promise<ScheduleResult> {
	if (isPastLocal(dateTime)) return calFailure('past');

	let startUtc: string;
	try {
		startUtc = localDateTimeToUtc(dateTime, getTimeZone());
	} catch {
		return calFailure('invalid');
	}
	const startMs = new Date(startUtc).getTime();

	try {
		// Conflicts with other meetings (any patient).
		const upcoming = await calRequest(
			`${CAL_BOOKINGS_URL}?${new URLSearchParams({ status: 'upcoming', take: '100' })}`,
			'GET',
		);
		const bookings: any[] = Array.isArray(upcoming.result?.data)
			? upcoming.result.data
			: [];
		const moving = bookings.find((b) => b?.uid === options.ignoreBookingId);
		const durationMs =
			Number(moving?.duration ?? DEFAULT_MEETING_MINUTES) * 60_000;
		const endMs = startMs + durationMs;
		const clash = bookings.some((b) => {
			if (!b?.uid || b.uid === options.ignoreBookingId) return false;
			const bStart = new Date(b.start).getTime();
			const bEnd = b.end
				? new Date(b.end).getTime()
				: bStart + Number(b.duration ?? DEFAULT_MEETING_MINUTES) * 60_000;
			return startMs < bEnd && bStart < endMs;
		});
		if (clash) return calFailure('conflict');

		// Inside the calendar's availability.
		const day = dateTime.slice(0, 10);
		const slots = await calRequest(
			`${CAL_SLOTS_URL}?${new URLSearchParams({
				eventTypeId: String(process.env.CAL_EVENT_TYPE_ID),
				start: day,
				end: day,
				timeZone: getTimeZone(),
			})}`,
			'GET',
			undefined,
			CAL_SLOTS_API_VERSION,
		);
		const byDay = slots.result?.data;
		if (slots.ok && byDay && typeof byDay === 'object' && !Array.isArray(byDay)) {
			const open = (Object.values(byDay) as any[][])
				.flat()
				.some((slot) => new Date(slot?.start).getTime() === startMs);
			if (!open) return calFailure('unavailable');
		} else {
			console.error('[Cal.com] Slot lookup unusable, skipping availability check:', slots.status);
		}
		return { success: true };
	} catch (error) {
		console.error('[Cal.com] Slot check threw:', error);
		return { success: true };
	}
}

/** Cancel an appointment by its Cal.com booking id. */
export async function cancelAppointment(
	bookingId: string,
): Promise<ScheduleResult> {
	if (!isCalConfigured()) return calFailure('config');

	try {
		const { ok, status, result } = await calRequest(
			`${CAL_BOOKINGS_URL}/${encodeURIComponent(bookingId)}/cancel`,
			'POST',
			{ cancellationReason: 'Cancelled by clinic staff' },
		);
		if (!ok) {
			// A 404 here means the booking itself is gone.
			const code = status === 404 ? 'not_found' : classifyFailure(status, result);
			console.error('[Cal.com] Cancel failed:', { status, code, body: result });
			return calFailure(code);
		}
		return { success: true, bookingId };
	} catch (error) {
		console.error('[Cal.com] Cancel threw:', error);
		return calFailure('upstream');
	}
}

/**
 * Move an appointment to a new local date/time (YYYY-MM-DDTHH:mm[:ss] in
 * CAL_TIME_ZONE). Cal.com issues a new booking id for the new slot.
 */
export async function rescheduleAppointment(
	bookingId: string,
	newDateTime: string,
): Promise<ScheduleResult> {
	if (!isCalConfigured()) return calFailure('config');

	let startUtc: string;
	try {
		startUtc = localDateTimeToUtc(newDateTime, getTimeZone());
	} catch (error) {
		console.error('[Cal.com] Bad date/time:', error);
		return calFailure('invalid');
	}

	try {
		const { ok, status, result } = await calRequest(
			`${CAL_BOOKINGS_URL}/${encodeURIComponent(bookingId)}/reschedule`,
			'POST',
			{ start: startUtc, reschedulingReason: 'Rescheduled by clinic staff' },
		);
		if (!ok) {
			// A 404 here means the booking itself is gone.
			const code = status === 404 ? 'not_found' : classifyFailure(status, result);
			console.error('[Cal.com] Reschedule failed:', { status, code, body: result });
			return calFailure(code);
		}
		const booking = result?.data;
		return {
			success: true,
			bookingId: String(booking?.uid ?? booking?.id ?? bookingId),
		};
	} catch (error) {
		console.error('[Cal.com] Reschedule threw:', error);
		return calFailure('upstream');
	}
}
