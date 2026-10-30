// app/api/schedule/check/route.ts
/**
 * Live check for the confirmation box: can this date/time be booked? Answers
 * 200 { ok, error? } so the UI can disable Confirm while the slot is bad. The
 * booking routes run the same check again, so this is only a convenience.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { checkSlot, findAppointment } from '@/lib/calendar';
import { prisma } from '@/lib/prisma';

const DateTimeSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Expected YYYY-MM-DDTHH:mm');

const CheckBodySchema = z.object({
	dateTime: DateTimeSchema,
	// Reschedule: the appointment being moved, so it doesn't conflict with itself.
	patientId: z.string().min(1).optional(),
	existingDateTime: DateTimeSchema.optional(),
});

export async function POST(request: Request) {
	try {
		const { dateTime, patientId, existingDateTime } = CheckBodySchema.parse(
			await request.json(),
		);

		let ignoreBookingId: string | undefined;
		if (patientId && existingDateTime) {
			const patient = await prisma.patient.findUnique({
				where: { id: patientId },
				select: { firstName: true, lastName: true },
			});
			if (patient) {
				const found = await findAppointment({
					patientName: `${patient.firstName} ${patient.lastName}`,
					dateTime: existingDateTime,
				});
				ignoreBookingId = found.bookingId;
			}
		}

		const slot = await checkSlot(dateTime, { ignoreBookingId });
		return NextResponse.json(
			slot.success ? { ok: true } : { ok: false, error: slot.error },
		);
	} catch (error) {
		if (error instanceof z.ZodError) {
			return NextResponse.json(
				{ ok: false, error: 'Please choose a valid date and time.' },
				{ status: 400 },
			);
		}
		console.error('Slot check error:', error);
		return NextResponse.json({ ok: true });
	}
}
