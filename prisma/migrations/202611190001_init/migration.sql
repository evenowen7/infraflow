-- CreateEnum
CREATE TYPE "Role" AS ENUM ('REQUESTER', 'APPROVER', 'OPERATOR', 'PLATFORM_ADMIN', 'AUDITOR');

-- CreateEnum
CREATE TYPE "Environment" AS ENUM ('DEV', 'TEST', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "Action" AS ENUM ('POWER_ON_VM', 'RESTART_VM', 'CREATE_VM');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SCHEDULED', 'QUEUED', 'RUNNING', 'VERIFYING', 'SUCCEEDED', 'COMPLETED_NOOP', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED', 'REQUIRES_REVIEW');

-- CreateEnum
CREATE TYPE "DispatchPhase" AS ENUM ('NOT_DISPATCHED', 'DISPATCHING', 'DISPATCHED');

-- CreateEnum
CREATE TYPE "Decision" AS ENUM ('APPROVE', 'REJECT');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED');

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "environments" "Environment"[],

    CONSTRAINT "RoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "csrfToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resource" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "adapterId" TEXT NOT NULL DEFAULT 'demo',
    "name" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "environment" "Environment" NOT NULL,
    "cpu" INTEGER NOT NULL,
    "ramGb" INTEGER NOT NULL,
    "diskGb" INTEGER NOT NULL,
    "networkId" TEXT NOT NULL,
    "templateId" TEXT,
    "powerState" TEXT NOT NULL DEFAULT 'poweredOff',
    "guestState" TEXT NOT NULL DEFAULT 'stopped',
    "bootMarker" TEXT,
    "serviceHealthy" BOOLEAN NOT NULL DEFAULT false,
    "guestRebootSupported" BOOLEAN NOT NULL DEFAULT true,
    "healthRequired" BOOLEAN NOT NULL DEFAULT true,
    "scenario" TEXT NOT NULL DEFAULT 'NORMAL',
    "mutationCount" INTEGER NOT NULL DEFAULT 0,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceDefinition" (
    "action" "Action" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "schema" JSONB NOT NULL,
    "verifierContract" JSONB NOT NULL,

    CONSTRAINT "ServiceDefinition_pkey" PRIMARY KEY ("action")
);

-- CreateTable
CREATE TABLE "Template" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SizeProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cpu" INTEGER NOT NULL,
    "ramGb" INTEGER NOT NULL,
    "diskGb" INTEGER NOT NULL,

    CONSTRAINT "SizeProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetworkProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cidr" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,

    CONSTRAINT "NetworkProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Request" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "environment" "Environment" NOT NULL,
    "action" "Action" NOT NULL,
    "resourceId" TEXT,
    "reason" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "status" "RequestStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "snapshot" JSONB,
    "snapshotHash" TEXT,
    "precheck" JSONB,
    "source" TEXT NOT NULL DEFAULT 'PORTAL',
    "sourceRevision" TEXT,
    "parentRequestId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "ticketId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestVersion" INTEGER NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "decision" "Decision" NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionRun" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "RequestStatus" NOT NULL DEFAULT 'QUEUED',
    "dispatchPhase" "DispatchPhase" NOT NULL DEFAULT 'NOT_DISPATCHED',
    "externalOperationId" TEXT,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceLock" (
    "key" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceLock_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "RunEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'DEMO',
    "outcome" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "precheck" JSONB NOT NULL,
    "postcheck" JSONB NOT NULL,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalTicket" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "environment" "Environment" NOT NULL,
    "approvalSource" TEXT NOT NULL DEFAULT 'PORTAL',
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "syncAttempts" INTEGER NOT NULL DEFAULT 0,
    "simulateSyncFailure" BOOLEAN NOT NULL DEFAULT false,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "teamId" TEXT NOT NULL,
    "environment" "Environment" NOT NULL,
    "action" TEXT NOT NULL,
    "requestId" TEXT,
    "runId" TEXT,
    "correlationId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RoleAssignment_userId_teamId_role_key" ON "RoleAssignment"("userId", "teamId", "role");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Resource_teamId_environment_idx" ON "Resource"("teamId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "Resource_adapterId_externalId_key" ON "Resource"("adapterId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Resource_adapterId_name_key" ON "Resource"("adapterId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Request_idempotencyKey_key" ON "Request"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Request_correlationId_key" ON "Request"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "Request_ticketId_key" ON "Request"("ticketId");

-- CreateIndex
CREATE INDEX "Request_teamId_environment_status_createdAt_idx" ON "Request"("teamId", "environment", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_requestId_requestVersion_key" ON "Approval"("requestId", "requestVersion");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionRun_requestId_key" ON "ExecutionRun"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionRun_externalOperationId_key" ON "ExecutionRun"("externalOperationId");

-- CreateIndex
CREATE INDEX "ExecutionRun_status_availableAt_leaseExpiresAt_idx" ON "ExecutionRun"("status", "availableAt", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceLock_runId_key" ON "ResourceLock"("runId");

-- CreateIndex
CREATE INDEX "RunEvent_runId_createdAt_idx" ON "RunEvent"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "ExternalTicket_teamId_environment_idx" ON "ExternalTicket"("teamId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalTicket_provider_externalId_key" ON "ExternalTicket"("provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "InboxEvent_provider_eventId_key" ON "InboxEvent"("provider", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_dedupeKey_key" ON "OutboxEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_availableAt_idx" ON "OutboxEvent"("status", "availableAt");

-- CreateIndex
CREATE INDEX "AuditEvent_teamId_environment_createdAt_idx" ON "AuditEvent"("teamId", "environment", "createdAt");

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "NetworkProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "ExternalTicket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionRun" ADD CONSTRAINT "ExecutionRun_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceLock" ADD CONSTRAINT "ResourceLock_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ExecutionRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunEvent" ADD CONSTRAINT "RunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ExecutionRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ExecutionRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxEvent" ADD CONSTRAINT "InboxEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "ExternalTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "ExternalTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE SET NULL ON UPDATE CASCADE;
