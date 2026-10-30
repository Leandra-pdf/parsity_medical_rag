// app/api/schedule/cancel/route.ts
/**
 * Cancel an appointment. The browser is not trusted: the patient is looked up
 * by id and the booking is found again by patient + date/time, so only an
 * appointment that really exists can be cancelled.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
	STATUS_FOR_CODE,
	cancelAppointment,
	findAppointment,
	isPastLocal,
} from '@/lib/calendar';
import { prisma } from '@/lib/prisma';

const CancelBodySchema = z.object({
	patientId: z.string().min(1),
	dateTime: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Expected YYYY-MM-DDTHH:mm'),
});

export async function POST(request: Request) {
	try {
		const { patientId, dateTime } = CancelBodySchema.parse(await request.json());

		if (isPastLocal(dateTime)) {
			return NextResponse.json(
				{ error: 'That appointment has already passed and can’t be cancelled.', code: 'past' },
				{ status: 400 },
			);
		}

		const patient = await prisma.patient.findUnique({
			where: { id: patientId },
			select: { firstName: true, lastName: true },
		});
		if (!patient) {
			return NextResponse.json(
				{ error: 'That patient could not be found in the records.' },
				{ status: 404 },
			);
		}
		const patientName = `${patient.firstName} ${patient.lastName}`;

		const found = await findAppointment({ patientName, dateTime });
		const result = found.success
			? await cancelAppointment(found.bookingId!)
			: found;

		if (!result.success) {
			const code = result.code ?? 'upstream';
			return NextResponse.json(
				{ error: result.error ?? 'Failed to cancel appointment', code },
				{ status: STATUS_FOR_CODE[code] },
			);
		}

		return NextResponse.json({
			success: true,
			message: `Appointment cancelled for ${patientName}`,
		});
	} catch (error) {
		if (error instanceof z.ZodError) {
			return NextResponse.json(
				{ error: 'Please check the appointment details and try again.' },
				{ status: 400 },
			);
		}
		console.error('Cancel error:', error);
		return NextResponse.json(
			{ error: 'Something went wrong while cancelling. Please try again.' },
			{ status: 500 },
		);
	}
}
