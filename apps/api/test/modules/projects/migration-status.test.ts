import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInput, MigrationStatusInput } from "@repo/contracts";
import { createResourceOperations } from "../../../../../packages/platform/src/resource-operations";
import { ProjectMigrationSchemas } from "@repo/contracts";
import {
  evaluateMigrationHistory,
  manifestDigest,
  PRISMA_HISTORY_PROBE,
} from "@repo/platform/engine/modules/projects/migration-status.evaluator";
const mocks = vi.hoisted(() => ({
  project: vi.fn(),
  deployment: vi.fn(),
  services: vi.fn(),
  resolve: vi.fn(),
  dispose: vi.fn(),
  exec: vi.fn(),
  containers: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: { project: { findById: mocks.project }, service: { listByDeployment: mocks.services } },
}));
vi.mock("@repo/platform/engine/lib/active-deployment", () => ({
  findActiveDeployment: mocks.deployment,
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({
  resolveDeploymentRuntimeForRead: mocks.resolve,
  disposeRuntime: mocks.dispose,
}));
import { getMigrationStatus } from "@repo/platform/engine/modules/projects/migration-status.service";
const revision = "a".repeat(40),
  checksum = "b".repeat(64);
const manifest = {
  revision,
  migrations: [
    { name: "001_init", checksum },
    { name: "002_next", checksum },
  ],
};
const row = (name: string, extra = {}) => ({
  name,
  checksum,
  finished: true,
  rolledBack: false,
  ...extra,
});
let dir: string;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  dir = await mkdtemp(join(tmpdir(), "openship-profile-test-"));
  process.env.OPENSHIP_MIGRATION_PROFILE_DIR = dir;
  await writeFile(
    join(dir, "p1.json"),
    JSON.stringify({
      version: 1,
      profile: "prisma-postgresql-v1",
      projectId: "p1",
      organizationId: "org1",
      runtimeRevision: revision,
      manifests: [manifest],
    }),
    { mode: 0o600 },
  );
  mocks.project.mockResolvedValue({ id: "p1", organizationId: "org1", activeDeploymentId: "dep1" });
  mocks.deployment.mockResolvedValue({
    id: "dep1",
    containerId: "c1",
    status: "ready",
    commitSha: revision,
  });
  mocks.services.mockResolvedValue([]);
  mocks.containers.mockResolvedValue([
    {
      id: "c1",
      state: "running",
      labels: { "openship.project": "p1", "openship.deployment": "dep1" },
    },
  ]);
  mocks.exec.mockResolvedValue(JSON.stringify([row("001_init"), row("002_next")]));
  mocks.resolve.mockResolvedValue({
    runtime: {
      supports: () => true,
      listAllContainers: mocks.containers,
      inContainerExecutor: async () => ({ exec: mocks.exec }),
    },
  });
});
afterEach(async () => {
  vi.useRealTimers();
  delete process.env.OPENSHIP_MIGRATION_PROFILE_DIR;
  await rm(dir, { recursive: true, force: true });
});
async function fresh() {
  return (await import("@repo/platform/engine/modules/projects/migration-status.service"))
    .getMigrationStatus;
}
describe("candidate history evaluation", () => {
  it.each([
    [[row("001_init"), row("002_next")], "UP_TO_DATE"],
    [[row("001_init")], "PENDING"],
    [[row("001_init"), row("002_next", { finished: false })], "FAILED"],
    [[row("001_init", { checksum: "c".repeat(64) })], "DIVERGED"],
    [[row("unknown")], "DIVERGED"],
    [[row("002_next")], "DIVERGED"],
    [[row("002_next"), row("001_init")], "DIVERGED"],
    [[row("001_init"), row("001_init")], "DIVERGED"],
    [[row("001_init", { finished: false, rolledBack: true }), row("001_init")], "PENDING"],
  ])("evaluates %j as %s", (rows, status) => {
    expect(evaluateMigrationHistory(manifest, rows).status).toBe(status);
  });
  it("rejects malformed/oversized evidence and ambiguous manifests", () => {
    expect(() => evaluateMigrationHistory(manifest, { unknown: true })).toThrow();
    expect(() => evaluateMigrationHistory(manifest, Array(1001).fill(row("001_init")))).toThrow();
    expect(() =>
      evaluateMigrationHistory(
        { revision, migrations: [manifest.migrations[0]!, manifest.migrations[0]!] },
        [],
      ),
    ).toThrow();
    expect(manifestDigest(manifest)).not.toBe(
      manifestDigest({ ...manifest, revision: "c".repeat(40) }),
    );
  });
});
describe("closed read contract", () => {
  it("rejects nonexact revisions and command/DSN/cwd fields", () => {
    for (const input of [
      { revision: "main" },
      { revision, command: "id" },
      { revision, dsn: "secret" },
      { revision, cwd: "/" },
    ])
      expect(() => parseInput(MigrationStatusInput, input)).toThrow();
  });
  it("requires project read authorization before execution for every identity", async () => {
    const authorize = vi.fn().mockRejectedValue(new Error("denied"));
    const inspect = vi.fn();
    const operations = createResourceOperations(
      ProjectMigrationSchemas,
      { authorize } as never,
      "project",
      { getMigrationStatus: inspect },
    );
    await expect(
      operations.getMigrationStatus({ organizationId: "other", userId: "user" } as never, "p1", {
        revision,
      }),
    ).rejects.toThrow("denied");
    expect(authorize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resourceId: "p1", action: "read", resourceType: "project" }),
    );
    expect(inspect).not.toHaveBeenCalled();
  });
});
describe("standalone migration observation", () => {
  it("supports zero services, binds exact revision/digest, and returns no raw history", async () => {
    const check = await fresh();
    const result = await check("p1", "org1", revision);
    expect(result.status).toBe("UP_TO_DATE");
    expect(result.manifestDigest).toBe(manifestDigest(manifest));
    expect(result.counts.applied).toBe(2);
    expect(JSON.stringify(result)).not.toContain("001_init");
    expect(mocks.exec).toHaveBeenCalledWith(expect.stringContaining("node -e"), { timeout: 10000 });
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });
  it("denies another organization without probing", async () => {
    await expect(getMigrationStatus("p1", "other", revision)).rejects.toThrow();
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it.each([
    "profile",
    "manifest",
    "runtime",
    "services",
    "owner",
    "deployment",
    "stopped",
    "error",
    "malformed",
    "oversized",
    "changed",
    "unreviewed",
  ])("fails closed for %s", async (kind) => {
    if (kind === "profile") delete process.env.OPENSHIP_MIGRATION_PROFILE_DIR;
    if (kind === "runtime") mocks.resolve.mockResolvedValue({ runtime: { supports: () => false } });
    if (kind === "services") mocks.services.mockResolvedValue([{ serviceId: "s1" }]);
    if (["owner", "deployment", "stopped"].includes(kind))
      mocks.containers.mockResolvedValue([
        {
          id: "c1",
          state: kind === "stopped" ? "exited" : "running",
          labels: {
            "openship.project": kind === "owner" ? "other" : "p1",
            "openship.deployment": kind === "deployment" ? "other" : "dep1",
          },
        },
      ]);
    if (kind === "error")
      mocks.exec.mockRejectedValue(new Error("postgres://SECRET\nPERSONAL_RECORD"));
    if (kind === "malformed") mocks.exec.mockResolvedValue("postgres://SECRET");
    if (kind === "oversized") mocks.exec.mockResolvedValue("x".repeat(300001));
    if (kind === "changed")
      mocks.project
        .mockResolvedValueOnce({ id: "p1", organizationId: "org1", activeDeploymentId: "dep1" })
        .mockResolvedValue({ id: "p1", organizationId: "org1", activeDeploymentId: "dep2" });
    if (kind === "unreviewed")
      mocks.deployment.mockResolvedValue({
        id: "dep1",
        containerId: "c1",
        status: "ready",
        commitSha: "c".repeat(40),
      });
    const result = await (
      await fresh()
    )("p1", "org1", kind === "manifest" ? "c".repeat(40) : revision);
    expect(result.status).toBe("UNKNOWN");
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PERSONAL_RECORD/);
  });
  it("bounds concurrency and throttle without returning old success", async () => {
    let release!: (v: string) => void;
    mocks.exec.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const check = await fresh();
    const first = check("p1", "org1", revision);
    await vi.waitFor(() => expect(mocks.exec).toHaveBeenCalled());
    expect((await check("p1", "org1", revision)).reason).toBe("BUSY");
    release(JSON.stringify([]));
    await first;
    expect((await check("p1", "org1", revision)).reason).toBe("BUSY");
  });
  it("returns UNKNOWN on overall deadline and retains admission until work settles", async () => {
    vi.useFakeTimers();
    mocks.exec.mockReturnValue(new Promise(() => {}));
    const check = await fresh();
    const result = check("p1", "org1", revision);
    await vi.advanceTimersByTimeAsync(15001);
    expect((await result).status).toBe("UNKNOWN");
    expect((await check("p1", "org1", revision)).reason).toBe("BUSY");
  });
});

describe("profile trust and admission", () => {
  it.each(["writable", "symlink", "organization", "duplicate"])(
    "rejects %s operator evidence before runtime execution",
    async (kind) => {
      const path = join(dir, "p1.json");
      if (kind === "writable") await chmod(path, 0o666);
      if (kind === "symlink") {
        await rm(path);
        await symlink(join(dir, "missing"), path);
      }
      if (kind === "organization" || kind === "duplicate")
        await writeFile(
          path,
          JSON.stringify({
            version: 1,
            profile: "prisma-postgresql-v1",
            projectId: "p1",
            organizationId: kind === "organization" ? "other" : "org1",
            runtimeRevision: revision,
            manifests: kind === "duplicate" ? [manifest, manifest] : [manifest],
          }),
        );
      expect((await (await fresh())("p1", "org1", revision)).status).toBe("UNKNOWN");
      expect(mocks.exec).not.toHaveBeenCalled();
    },
  );
  it("admits at most four concurrent projects", async () => {
    mocks.project.mockImplementation(async (id: string) => ({
      id,
      organizationId: "org1",
      activeDeploymentId: `dep_${id}`,
    }));
    mocks.deployment.mockImplementation(async (p: { id: string }) => ({
      id: `dep_${p.id}`,
      containerId: `c_${p.id}`,
      status: "ready",
      commitSha: revision,
    }));
    const ids = ["p1", "p2", "p3", "p4", "p5"];
    for (const id of ids)
      await writeFile(
        join(dir, `${id}.json`),
        JSON.stringify({
          version: 1,
          profile: "prisma-postgresql-v1",
          projectId: id,
          organizationId: "org1",
          runtimeRevision: revision,
          manifests: [manifest],
        }),
        { mode: 0o600 },
      );
    mocks.containers.mockResolvedValue(
      ids.map((id) => ({
        id: `c_${id}`,
        state: "running",
        labels: { "openship.project": id, "openship.deployment": `dep_${id}` },
      })),
    );
    let release!: (v: string) => void;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    mocks.exec.mockReturnValue(hold);
    const check = await fresh();
    const first = ids.slice(0, 4).map((id) => check(id, "org1", revision));
    await vi.waitFor(() => expect(mocks.exec).toHaveBeenCalledTimes(4));
    expect((await check("p5", "org1", revision)).reason).toBe("BUSY");
    release("[]");
    await Promise.all(first);
  });
});
