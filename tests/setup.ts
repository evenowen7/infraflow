import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { afterAll, beforeEach } from 'vitest';

// This setup executes before test modules: never import db until the URL is replaced.
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), override: false });

function testDatabaseName(value: string | undefined): string {
  if (!value) throw new Error('TEST_DATABASE_URL is required; refusing to use the demo database');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid test database URL');
  }
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !name.endsWith('_test') || name.includes('/')) {
    throw new Error('Refusing database access: the database name must end in _test');
  }
  return name;
}

const databaseName = testDatabaseName(process.env.TEST_DATABASE_URL);
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;
process.env.APP_MODE = 'DEMO';
process.env.LOGIN_RATE_LIMIT = '1000';

beforeEach(async () => {
  process.env.APP_MODE = 'DEMO';
  process.env.LOGIN_RATE_LIMIT = '1000';
  if (testDatabaseName(process.env.DATABASE_URL) !== databaseName) {
    throw new Error('Refusing reset: DATABASE_URL changed after test initialization');
  }
  const { db } = await import('../apps/api/src/db.js');
  await db.$transaction(async tx => {
    // Check the actual connection as well as the environment before any destructive SQL.
    const rows = await tx.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (rows[0]?.name !== databaseName || !rows[0].name.endsWith('_test')) {
      throw new Error('Refusing reset: connected database is not the isolated test database');
    }
    await tx.$executeRaw`
      TRUNCATE TABLE "RunEvent", "Evidence", "ResourceLock", "OutboxEvent", "InboxEvent",
        "AuditEvent", "Approval", "ExecutionRun", "Request", "ExternalTicket", "Session",
        "RoleAssignment", "Resource", "User", "Team", "NetworkProfile", "Template",
        "SizeProfile", "ServiceDefinition" RESTART IDENTITY CASCADE
    `;
  });
  const { seed } = await import('../prisma/seed.js');
  await seed();
});

afterAll(async () => {
  const { db } = await import('../apps/api/src/db.js');
  await db.$disconnect();
});
