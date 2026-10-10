import { beforeEach, afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
let repo: string;
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
const generate = (sha: string) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../../../../scripts/migration-status-manifest.mjs", import.meta.url),
        ),
        repo,
        sha,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).toString(),
  );
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "migration-manifest-"));
  git("init");
  git("config", "user.name", "Synthetic fixture");
  git("config", "user.email", "fixture@example.invalid");
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});
const commit = () => {
  git("add", "-A");
  git(
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "synthetic migrations",
  );
  return git("rev-parse", "HEAD");
};
it("hashes exact committed bytes in stable ASCII order and ignores unstaged edits", async () => {
  for (const [name, sql] of [
    ["002_next", "SELECT 2;\r\n"],
    ["001_init", "SELECT 1;\n"],
  ]) {
    await mkdir(join(repo, "prisma/migrations", name!), { recursive: true });
    await writeFile(join(repo, "prisma/migrations", name!, "migration.sql"), sql!);
  }
  const sha = commit();
  await writeFile(join(repo, "prisma/migrations/001_init/migration.sql"), "UNREVIEWED");
  const { manifest, digest } = generate(sha);
  expect(manifest.revision).toBe(sha);
  expect(manifest.migrations.map((m: { name: string }) => m.name)).toEqual([
    "001_init",
    "002_next",
  ]);
  expect(manifest.migrations[0].checksum).toBe(
    createHash("sha256").update("SELECT 1;\n").digest("hex"),
  );
  expect(digest).toBe(createHash("sha256").update(JSON.stringify(manifest)).digest("hex"));
  expect(() => generate("main")).toThrow();
});
it("rejects a symlink migration instead of trusting external content", async () => {
  await mkdir(join(repo, "prisma/migrations/001_init"), { recursive: true });
  await symlink("/untrusted", join(repo, "prisma/migrations/001_init/migration.sql"));
  expect(() => generate(commit())).toThrow();
});
