import { describe, expect, it, vi } from "vitest";
import { createAuthorization } from "../../../../../packages/platform/src/authorization";
import { createRemoteProjectOperations } from "../../../../../packages/sdk/src/project-client";
import { ProjectMigrationSchemas } from "@repo/contracts";
import { createResourceOperations } from "../../../../../packages/platform/src/resource-operations";
import type { ExecutionContext } from "../../../../../packages/platform/src/context";
import { runInNewContext } from "node:vm";
import { PRISMA_HISTORY_PROBE } from "@repo/platform/engine/modules/projects/migration-status.evaluator";
const revision = "a".repeat(40);
const result = {
  projectId: "p1",
  organizationId: "org1",
  status: "UP_TO_DATE",
  revision,
  activeRevision: revision,
  deploymentId: "dep1",
  manifestDigest: "b".repeat(64),
  checkedAt: new Date().toISOString(),
  counts: { expected: 0, applied: 0, pending: 0, failed: 0, divergent: 0 },
  reason: "COMPLETE",
};
function policy() {
  const grants = {
    findForResource: vi.fn(async (_org: string, _user: string, type: string, id: string) =>
      type === "project" && id === "p1" ? { permissions: ["read"] as const } : null,
    ),
  };
  const repos = {
    member: { find: vi.fn(async () => ({ id: "member", role: "owner" })) },
    project: {
      findById: vi.fn(async (id: string) => ({
        organizationId: id === "foreign" ? "org2" : "org1",
      })),
    },
    server: { get: vi.fn(async () => ({ organizationId: "org1" })) },
  };
  return createAuthorization({ repos: repos as never, grantSourceFor: () => grants });
}
const ctx = {
  userId: "u1",
  user: { id: "u1" },
  organizationId: "org1",
  role: "restricted",
  scopeMode: "fixed",
  tokenScope: { tokenId: "token" },
  credential: { organizationId: "org1", readOnly: true },
} as ExecutionContext;
describe("migration read token contract", () => {
  it("permits only the scoped project read and retains read-only deploy/exec denial", async () => {
    const authorization = policy();
    const inspect = vi.fn(async () => result);
    const operations = createResourceOperations(ProjectMigrationSchemas, authorization, "project", {
      getMigrationStatus: inspect,
    });
    expect((await operations.getMigrationStatus(ctx, "p1", { revision })).data).toEqual(result);
    for (const id of ["p2", "foreign"])
      await expect(operations.getMigrationStatus(ctx, id, { revision })).rejects.toThrow();
    await expect(
      operations.getMigrationStatus(
        { ...ctx, credential: { ...ctx.credential!, expiresAt: 1 } },
        "p1",
        { revision },
      ),
    ).rejects.toThrow();
    for (const input of [
      { resourceType: "project", resourceId: "p1", action: "write" },
      { resourceType: "service", resourceId: "s1", action: "write" },
      { resourceType: "server", resourceId: "server1", action: "admin" },
    ]) {
      await expect(authorization.authorize(ctx, input as never)).rejects.toMatchObject({
        code: "TOKEN_READ_ONLY",
      });
    }
    expect(inspect).toHaveBeenCalledTimes(1);
  });
  it("SDK sends the exact revision by GET and unwraps the minimized contract", async () => {
    const request = vi.fn(async () => ({ data: result }));
    const client = createRemoteProjectOperations({
      url: (path: string) => new URL(path, "https://example.test/api/"),
      request,
    } as never);
    expect(await client.getMigrationStatus("p1", { revision })).toEqual(result);
    expect(request).toHaveBeenCalledWith(
      `https://example.test/projects/p1/migration-status?revision=${revision}`,
      { method: "GET" },
    );
  });
  it("SDK omits an invalid credential-bearing response from errors", async () => {
    const client = createRemoteProjectOperations({
      url: (path: string) => new URL(path, "https://example.test/"),
      request: async () => ({ data: { secret: "SECRET" } }),
    } as never);
    await expect(client.getMigrationStatus("p1", { revision })).rejects.toMatchObject({
      body: null,
    });
  });
});
describe("fixed Prisma probe executable", () => {
  it("runs only fixed read-only statements, suppresses errors and disconnects", async () => {
    for (const failure of [false, true]) {
      const statements: string[] = [];
      let output = "";
      const disconnect = vi.fn(async () => {});
      class PrismaClient {
        $disconnect = disconnect;
        async $transaction(fn: (tx: unknown) => Promise<unknown>) {
          return fn({
            $executeRawUnsafe: async (sql: string) => {
              statements.push(sql);
            },
            $queryRawUnsafe: async (sql: string) => {
              statements.push(sql);
              if (failure) throw new Error("postgres://SECRET PERSONAL_RECORD");
              return [];
            },
          });
        }
      }
      await runInNewContext(PRISMA_HISTORY_PROBE, {
        require: (path: string) => {
          expect(path).toBe("/app/node_modules/@prisma/client");
          return { PrismaClient };
        },
        process: {
          stdout: {
            write: (s: string) => {
              output += s;
            },
          },
          exit: vi.fn(),
        },
        setTimeout: () => 1,
        clearTimeout: vi.fn(),
      });
      expect(statements[0]).toBe("SET TRANSACTION READ ONLY");
      expect(statements[2]).toMatch(/^SELECT migration_name.*FROM public\._prisma_migrations/);
      expect(output).toBe(failure ? '{"unknown":true}' : "[]");
      expect(disconnect).toHaveBeenCalledTimes(1);
    }
  });
});
