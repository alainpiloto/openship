import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { repos } from "@repo/db";
import type { ProjectMigrationStatus } from "@repo/contracts";
import { assertResourceInOrg } from "../../lib/resource-access";
import { findActiveDeployment } from "../../lib/active-deployment";
import { resolveDeploymentRuntimeForRead, disposeRuntime } from "../../lib/deployment-runtime";
import {
  profileSchema,
  manifestDigest,
  evaluateMigrationHistory,
  PRISMA_HISTORY_PROBE,
} from "./migration-status.evaluator";

const running = new Set<string>();
const lastStarted = new Map<string, number>();
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const indeterminate = (
  projectId: string,
  organizationId: string,
  revision: string,
  reason: ProjectMigrationStatus["reason"] = "INDETERMINATE",
): ProjectMigrationStatus => ({
  status: "UNKNOWN",
  projectId,
  organizationId,
  revision,
  deploymentId: null,
  activeRevision: null,
  manifestDigest: null,
  checkedAt: new Date().toISOString(),
  counts: { expected: null, applied: null, pending: null, failed: null, divergent: null },
  reason,
});

export async function getMigrationStatus(
  projectId: string,
  organizationId: string,
  revision: string,
): Promise<ProjectMigrationStatus> {
  const unknown = (revision: string, reason?: ProjectMigrationStatus["reason"]) =>
    indeterminate(projectId, organizationId, revision, reason);
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", organizationId, projectId);
  const scopedProject = project;
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(projectId) || !/^[a-f0-9]{40}$/.test(revision))
    return unknown(revision);
  if (
    running.has(projectId) ||
    running.size >= 4 ||
    Date.now() - (lastStarted.get(projectId) ?? 0) < 5000
  )
    return unknown(revision, "BUSY");
  // Bound the throttle map; no unbounded per-project cache or stale successful evidence.
  for (const [key, time] of lastStarted) if (Date.now() - time >= 5000) lastStarted.delete(key);
  running.add(projectId);
  lastStarted.set(projectId, Date.now());
  const work = inspect()
    .catch(() => unknown(revision))
    .finally(() => running.delete(projectId));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<ProjectMigrationStatus>((resolve) => {
        timer = setTimeout(() => resolve(unknown(revision)), 15000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  async function inspect(): Promise<ProjectMigrationStatus> {
    let profile;
    try {
      // This operator-owned directory must not be mounted into application containers.
      const root = process.env.OPENSHIP_MIGRATION_PROFILE_DIR;
      if (!root || !root.startsWith("/")) return unknown(revision, "PROFILE_UNAVAILABLE");
      const file = await open(
        join(root, `${projectId}.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.size > 1_000_000 ||
          (stat.mode & 0o022) !== 0 ||
          (stat.uid !== 0 && stat.uid !== process.getuid?.())
        )
          return unknown(revision, "PROFILE_UNAVAILABLE");
        profile = profileSchema.parse(JSON.parse(await file.readFile("utf8")));
      } finally {
        await file.close();
      }
    } catch {
      return unknown(revision, "PROFILE_UNAVAILABLE");
    }
    if (profile.projectId !== projectId || profile.organizationId !== organizationId)
      return unknown(revision, "PROFILE_UNAVAILABLE");
    const candidates = profile.manifests.filter((m) => m.revision === revision);
    if (candidates.length !== 1) return unknown(revision, "MANIFEST_UNAVAILABLE");
    const manifest = candidates[0]!;
    const dep = await findActiveDeployment(scopedProject);
    if (
      !dep ||
      dep.status !== "ready" ||
      !dep.containerId ||
      !dep.commitSha ||
      dep.commitSha !== profile.runtimeRevision
    )
      return unknown(revision);
    // Only standalone deployments in v1; never silently choose a database sidecar.
    if ((await repos.service.listByDeployment(dep.id)).length) return unknown(revision);
    const { runtime } = await resolveDeploymentRuntimeForRead(dep);
    try {
      if (
        !runtime.supports("isolatedExec") ||
        !runtime.supports("hostContainerQuery") ||
        !runtime.listAllContainers ||
        !runtime.inContainerExecutor
      )
        return unknown(revision);
      const match = (await runtime.listAllContainers()).filter(
        (c) =>
          c.id === dep.containerId &&
          c.state === "running" &&
          c.labels["openship.project"] === projectId &&
          c.labels["openship.deployment"] === dep.id,
      );
      if (match.length !== 1) return unknown(revision);
      const executor = await runtime.inContainerExecutor(match[0]!.id);
      // No raw error/output is reported or audited by this service.
      const raw = await executor.exec(`node -e ${quote(PRISMA_HISTORY_PROBE)} 2>/dev/null`, {
        timeout: 10000,
      });
      if (Buffer.byteLength(raw, "utf8") > 300_000) return unknown(revision);
      const evaluation = evaluateMigrationHistory(manifest, JSON.parse(raw));
      const after = await repos.project.findById(projectId);
      assertResourceInOrg(after, "Project", organizationId, projectId);
      const current = await findActiveDeployment(after);
      if (
        after.activeDeploymentId !== dep.id ||
        current?.containerId !== dep.containerId ||
        current?.commitSha !== dep.commitSha ||
        current?.status !== "ready"
      )
        return unknown(revision);
      return {
        ...evaluation,
        projectId,
        organizationId,
        revision,
        deploymentId: dep.id,
        activeRevision: dep.commitSha,
        manifestDigest: manifestDigest(manifest),
        checkedAt: new Date().toISOString(),
        reason: "COMPLETE",
      };
    } finally {
      disposeRuntime(runtime);
    }
  }
}
