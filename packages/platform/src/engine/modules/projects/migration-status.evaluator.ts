import { createHash } from "node:crypto";
import { z } from "zod";

const migration = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const manifestSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    migrations: z.array(migration).max(1000),
  })
  .strict();
export const profileSchema = z
  .object({
    version: z.literal(1),
    profile: z.literal("prisma-postgresql-v1"),
    projectId: z.string(),
    organizationId: z.string(),
    runtimeRevision: z.string().regex(/^[a-f0-9]{40}$/),
    manifests: z.array(manifestSchema).max(100),
  })
  .strict();
export const historySchema = z
  .array(migration.extend({ finished: z.boolean(), rolledBack: z.boolean() }).strict())
  .max(1000);
export type Manifest = z.infer<typeof manifestSchema>;
export function manifestDigest(manifest: Manifest) {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}
export function evaluateMigrationHistory(manifest: Manifest, raw: unknown) {
  const rows = historySchema.parse(raw);
  const names = manifest.migrations.map((m) => m.name);
  if (new Set(names).size !== names.length || names.some((n, i) => i > 0 && n <= names[i - 1]!))
    throw new Error("Invalid manifest");
  const live = rows.filter((r) => !r.rolledBack);
  const failed = live.filter((r) => !r.finished).length;
  const applied = live.filter((r) => r.finished);
  const expected = new Map(manifest.migrations.map((m) => [m.name, m.checksum]));
  const seen = new Set<string>();
  let divergent = 0;
  for (const row of live) {
    if (expected.get(row.name) !== row.checksum || seen.has(row.name)) divergent++;
    seen.add(row.name);
  }
  const appliedNames = new Set(applied.map((r) => r.name));
  const pending = names.filter((n) => !appliedNames.has(n)).length;
  applied.forEach((row, i) => {
    if (names[i] !== row.name) divergent++;
  });
  // A hole before a later applied migration is not a safe pending suffix.
  let missing = false;
  for (const name of names) {
    if (!appliedNames.has(name)) missing = true;
    else if (missing) divergent++;
  }
  return {
    status: divergent
      ? ("DIVERGED" as const)
      : failed
        ? ("FAILED" as const)
        : pending
          ? ("PENDING" as const)
          : ("UP_TO_DATE" as const),
    counts: { expected: names.length, applied: applied.length, pending, failed, divergent },
  };
}

// No user input, no CLI download, no application scripts, no domain rows or DSN output.
// Only the installed generated client and a fixed read-only PostgreSQL transaction.
// Child lifetime is bounded even when the executor timeout only closes transport.
export const PRISMA_HISTORY_PROBE = String.raw`
const timer = setTimeout(() => process.exit(2), 8000);
(async () => {
  let client;
  try {
    const { PrismaClient } = require('/app/node_modules/@prisma/client');
    client = new PrismaClient({ log: [] });
    const rows = await client.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5000ms'");
      return tx.$queryRawUnsafe('SELECT migration_name AS name, checksum, (finished_at IS NOT NULL) AS finished, (rolled_back_at IS NOT NULL) AS "rolledBack" FROM public._prisma_migrations ORDER BY started_at, id LIMIT 1001');
    }, { timeout: 6000, maxWait: 1000 });
    if (rows.length > 1000) throw new Error();
    process.stdout.write(JSON.stringify(rows));
  } catch { process.stdout.write('{"unknown":true}'); }
  finally { if (client) await client.$disconnect().catch(() => {}); clearTimeout(timer); }
})();
`;
