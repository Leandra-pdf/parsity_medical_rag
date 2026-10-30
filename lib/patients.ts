import { prisma } from './prisma';

/**
 * Look up patients by (partial) name.
 *
 * Used by the scheduling flow to confirm a named patient actually exists before
 * offering an appointment. (The old hand-coded query builders are gone — the
 * chat SQL agent now writes its own SQL in lib/agents/sql.ts; this one small
 * lookup stays because scheduling needs an exact patient object, not free text.)
 */
export async function findPatientByName(name: string) {
  const terms = name.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  return prisma.patient.findMany({
    where: {
      AND: terms.map((term) => ({
        OR: [
          { firstName: { contains: term, mode: 'insensitive' as const } },
          { lastName: { contains: term, mode: 'insensitive' as const } },
        ],
      })),
    },
    take: 5,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Patient resolution: used by scheduling and by patient-scoped questions.
// ─────────────────────────────────────────────────────────────────────────

export type PatientMatch = Awaited<ReturnType<typeof findPatientByName>>[number];

export type ResolveResult =
  | { status: 'found'; patient: PatientMatch }
  | { status: 'ambiguous'; matches: PatientMatch[] }
  | { status: 'not_found'; suggestions: PatientMatch[] };

/** True when the name has at least a first and a last name. */
export function isFullName(name: string): boolean {
  return name.trim().split(/\s+/).filter(Boolean).length >= 2;
}

const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export function describePatient(p: PatientMatch): string {
  const born = isoDate(p.birthDate);
  const where = [p.city, p.state].filter(Boolean).join(', ');
  return `${p.firstName} ${p.lastName}${born ? ` (born ${born}` : ' ('}${
    where ? `${born ? ', ' : ''}${where}` : ''
  })`;
}

/**
 * Resolve a full name (optionally with a date of birth) to exactly one patient.
 * Only an exact first + last name match counts as "found"; near matches come
 * back as suggestions so the user can confirm.
 */
export async function resolvePatient(
  name: string,
  dob?: string | null,
): Promise<ResolveResult> {
  const candidates = await findPatientByName(name);
  const tokens = name.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const first = tokens[0];
  const last = tokens[tokens.length - 1];

  let exact = candidates.filter(
    (p) =>
      p.firstName?.toLowerCase() === first &&
      p.lastName?.toLowerCase() === last,
  );

  if (exact.length > 1 && dob) {
    const byDob = exact.filter((p) => isoDate(p.birthDate) === dob);
    if (byDob.length) exact = byDob;
  }

  if (exact.length === 1) return { status: 'found', patient: exact[0] };
  if (exact.length > 1) return { status: 'ambiguous', matches: exact };
  return { status: 'not_found', suggestions: candidates };
}

/** The chat message to show when a name did not resolve to one patient. */
export function lookupFailureMessage(
  result: Exclude<ResolveResult, { status: 'found' }>,
  name: string,
): string {
  if (result.status === 'ambiguous') {
    return `I found more than one patient named **${name}**:\n\n${result.matches
      .map((p) => `- ${describePatient(p)}`)
      .join('\n')}\n\nWhich one do you mean? Reply with their date of birth (YYYY-MM-DD).`;
  }
  if (result.suggestions.length) {
    return `I couldn't find an exact match for **${name}** in the patient records. Did you mean:\n\n${result.suggestions
      .map((p) => `- ${describePatient(p)}`)
      .join('\n')}\n\nPlease give me the patient's full name as it appears in the records.`;
  }
  return `I couldn't find a patient named **${name}** in the records. Please check the spelling and give me their full name.`;
}

const ageBetween = (from: Date, to: Date) =>
  Math.floor((to.getTime() - from.getTime()) / 31557600000);

/** A compact text profile of one patient, for the aggregator. */
export async function getPatientProfile(patientId: string): Promise<string> {
  const p = await prisma.patient.findUnique({
    where: { id: patientId },
    include: {
      conditions: { orderBy: { onsetDate: 'desc' }, take: 25 },
      medications: { where: { status: 'active' }, take: 15 },
    },
  });
  if (!p) return 'Patient record not found.';

  const age = p.birthDate
    ? ageBetween(p.birthDate, p.deathDate ?? new Date())
    : null;

  return [
    `Patient: ${p.firstName} ${p.lastName}`,
    `Gender: ${p.gender ?? 'unknown'} | Born: ${isoDate(p.birthDate) ?? 'unknown'}${
      age != null ? ` (${p.deathDate ? 'age at death' : 'age'} ${age})` : ''
    } | Status: ${p.deathDate ? 'deceased' : 'alive'}`,
    `Location: ${[p.city, p.state].filter(Boolean).join(', ') || 'unknown'}`,
    `Conditions: ${
      p.conditions
        .map((c) => `${c.display}${c.clinicalStatus ? ` (${c.clinicalStatus})` : ''}`)
        .join('; ') || 'none recorded'
    }`,
    `Active medications: ${p.medications.map((m) => m.display).join('; ') || 'none recorded'}`,
  ].join('\n');
}
