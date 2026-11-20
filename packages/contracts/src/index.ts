import { z } from 'zod';

export const actions = ['POWER_ON_VM', 'RESTART_VM', 'CREATE_VM'] as const;
export const statuses = ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SCHEDULED', 'QUEUED', 'RUNNING', 'VERIFYING', 'SUCCEEDED', 'COMPLETED_NOOP', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED', 'REQUIRES_REVIEW'] as const;
export type Status = typeof statuses[number];
export const transitions: Record<Status, readonly Status[]> = {
  DRAFT: ['AWAITING_APPROVAL', 'CANCELLED'], AWAITING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['SCHEDULED', 'QUEUED', 'CANCELLED', 'EXPIRED'], SCHEDULED: ['RUNNING', 'CANCELLED', 'EXPIRED', 'FAILED'],
  QUEUED: ['RUNNING', 'CANCELLED', 'EXPIRED', 'FAILED'], RUNNING: ['VERIFYING', 'COMPLETED_NOOP', 'FAILED', 'EXPIRED', 'REQUIRES_REVIEW'],
  VERIFYING: ['SUCCEEDED', 'FAILED', 'REQUIRES_REVIEW'], REQUIRES_REVIEW: ['SUCCEEDED', 'FAILED'],
  SUCCEEDED: [], COMPLETED_NOOP: [], REJECTED: [], CANCELLED: [], EXPIRED: [], FAILED: [],
};
export const scheduleSchema = z.string().datetime({ offset: true }).nullable().optional();
export const createRequestSchema = z.object({
  action: z.enum(actions), resourceId: z.string().min(1).optional(),
  reason: z.string().trim().min(10, 'Alasan minimal 10 karakter').max(1000),
  parameters: z.record(z.string(), z.unknown()).default({}), scheduledAt: scheduleSchema,
}).strict();
export const updateDraftSchema = createRequestSchema.omit({ action: true }).partial().strict();
export const decisionSchema = z.object({ decision: z.enum(['APPROVE', 'REJECT']), reason: z.string().trim().min(5).max(1000) }).strict();
export const powerParameters = z.object({}).strict();
export const createVmParameters = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/, 'Nama: 3–40 huruf kecil, angka, tanda hubung'),
  templateId: z.string().min(1), sizeId: z.string().min(1), networkId: z.string().min(1),
  teamId: z.string().min(1), owner: z.string().email(), environment: z.enum(['DEV', 'TEST']),
}).strict();
export const demoTicketSchema = z.object({
  provider: z.literal('DEMO_DESK'), eventId: z.string().min(1).max(100), externalTicketId: z.string().min(1).max(100),
  revision: z.string().min(1).max(30), requesterEmail: z.string().email(), action: z.literal('POWER_ON_VM'),
  targetExternalId: z.string().min(1).max(100), reason: z.string().min(10).max(1000),
  approvalSource: z.literal('PORTAL'), approved: z.boolean().optional(),
}).strict();
export function wibToIso(value: string): string {
  return new Date(`${value}:00+07:00`).toISOString();
}
