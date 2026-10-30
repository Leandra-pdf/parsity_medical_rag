// app/api/schedule/reschedule/route.ts
/**
 * Reschedule an appointment. The existing appointment is found again by
 * patient + date/time (the browser is not trusted), then moved to newDateTime.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
	STATUS_FOR_CODE,
	checkSlot,
	findAppointment,
	isPastLocal,
	rescheduleAppointment,
} from '@/lib/calendar';
import { prisma } from '@/lib/prisma';

const DateTimeSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Expected YYYY-MM-DDTHH:mm');

const RescheduleBodySchema = z.object({
	patientId: z.string().min(1),
	dateTime: DateTimeSchema,
	newDateTime: DateTimeSchema,
});

export async function POST(request: Request) {
	try {
		const { patientId, dateTime, newDateTime } = RescheduleBodySchema.parse(
			await request.json(),
		);

		if (isPastLocal(dateTime)) {
			return NextResponse.json(
				{ error: 'That appointment has already passed and can’t be rescheduled.', code: 'past' },
				{ status: 400 },
			);
		}

		const patient = await prisma.patient.findUnique({
			where: { id: patientId },
			select: { firstName: true, lastName: true, deathDate: true },
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
				{ error: `${patientName} is deceased, so an appointment can't be rescheduled.` },
				{ status: 400 },
			);
		}

		const found = await findAppointment({ patientName, dateTime });
		const slot = found.success
			? await checkSlot(newDateTime, { ignoreBookingId: found.bookingId })
			: found;
		const result = !slot.success
			? slot
			: await rescheduleAppointment(found.bookingId!, newDateTime);

		if (!result.success) {
			const code = result.code ?? 'upstream';
			return NextResponse.json(
				{ error: result.error ?? 'Failed to reschedule appointment', code },
				{ status: STATUS_FOR_CODE[code] },
			);
		}

		return NextResponse.json({
			success: true,
			message: `Appointment rescheduled for ${patientName}`,
			bookingId: result.bookingId,
		});
	} catch (error) {
		if (error instanceof z.ZodError) {
			return NextResponse.json(
				{ error: 'Please check the appointment details and try again.' },
				{ status: 400 },
			);
		}
		console.error('Reschedule error:', error);
		return NextResponse.json(
			{ error: 'Something went wrong while rescheduling. Please try again.' },
			{ status: 500 },
		);
	}
}
