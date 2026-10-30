// app/api/schedule/route.ts
/**
 * Appointment Scheduling API
 *
 * Human-in-the-loop endpoint: the user confirms the scheduling card in the
 * chat, then the browser posts here. The browser is not trusted: the patient
 * is looked up again by id, and the name that goes to Cal.com comes from the
 * database, not from the request.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
	isCalConfigured,
	scheduleAppointment,
	STATUS_FOR_CODE,
	checkSlot,
} from '@/lib/calendar';
import { prisma } from '@/lib/prisma';
import { callToConfirmAppointment, isRetellConfigured } from '@/lib/retell';

const ScheduleBodySchema = z.object({
	patientId: z.string().min(1),
	dateTime: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Expected YYYY-MM-DDTHH:mm'),
	notes: z.string().nullish(),
});

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
	}

	const parsed = ScheduleBodySchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: 'Please check the appointment details and try again.' },
			{ status: 400 },
		);
	}
	const { patientId, dateTime, notes } = parsed.data;

	try {
		if (!isCalConfigured()) {
			return NextResponse.json(
				{ error: 'Calendar integration is not configured.', code: 'config' },
				{ status: 503 },
			);
		}

		const patient = await prisma.patient.findUnique({
			where: { id: patientId },
			select: { id: true, firstName: true, lastName: true, deathDate: true },
		});
		if (!patient) {
			return NextResponse.json(
				{ error: 'That patient could not be found in the records.' },
				{ status: 404 },
			);
		}
		const patientName = `${patient.firstName} ${patient.lastName}`;
		if (patient.deathDate) {
			return NextResponse.json(
				{ error: `${patientName} is deceased, so an appointment can't be booked.` },
				{ status: 400 },
			);
		}

		const slot = await checkSlot(dateTime);
		if (!slot.success) {
			const code = slot.code ?? 'upstream';
			return NextResponse.json(
				{ error: slot.error, code },
				{ status: STATUS_FOR_CODE[code] },
			);
		}

		const result = await scheduleAppointment({
			patientName,
			patientId: patient.id,
			dateTime,
			notes,
		});

		if (!result.success) {
			const code = result.code ?? 'upstream';
			return NextResponse.json(
				{ error: result.error ?? 'Failed to schedule appointment', code },
				{ status: STATUS_FOR_CODE[code] },
			);
		}

		// EXTENSION: after booking, place a Retell confirmation call. Best-effort:
		// a call failure must never undo a successful booking.
		let confirmationCall;
		if (isRetellConfigured()) {
			try {
				confirmationCall = await callToConfirmAppointment({ patientName, dateTime });
			} catch (err) {
				console.error('Confirmation call failed (non-blocking):', err);
				confirmationCall = { called: false, reason: 'call failed' };
			}
		}

		return NextResponse.json({
			success: true,
			message: `Appointment scheduled for ${patientName}`,
			bookingId: result.bookingId,
			bookingUrl: result.bookingUrl,
			confirmationCall,
		});
	} catch (error) {
		console.error('Schedule error:', error);
		return NextResponse.json(
			{ error: 'Something went wrong while scheduling. Please try again.' },
			{ status: 500 },
		);
	}
}
