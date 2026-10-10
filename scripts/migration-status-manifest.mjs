#!/usr/bin/env node
// Operator-only: read Git objects at a reviewed immutable revision. Never runs repo code.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const [repo, revision] = process.argv.slice(2);
if (!repo || !/^[a-f0-9]{40}$/.test(revision ?? ""))
  throw new Error("Usage: node scripts/migration-status-manifest.mjs <trusted-repo> <full-sha>");
const git = (...args) =>
  execFileSync("git", ["-C", repo, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
if (git("rev-parse", `${revision}^{commit}`).toString().trim() !== revision)
  throw new Error("Exact commit required");
const migrations = [];
for (const entry of git("ls-tree", "-r", "-z", revision, "--", "prisma/migrations")
  .toString()
  .split("\0")
  .filter(Boolean)) {
  const match =
    /^(\d+) blob ([a-f0-9]+)\t(prisma\/migrations\/([A-Za-z0-9_-]{1,200})\/migration\.sql)$/.exec(
      entry,
    );
  if (!match) {
    if (entry.endsWith("/migration.sql")) throw new Error("Invalid migration path");
    continue;
  }
  if (match[1] !== "100644" && match[1] !== "100755")
    throw new Error("Migration must be a regular file");
  const sql = git("cat-file", "blob", match[2]);
  migrations.push({ name: match[4], checksum: createHash("sha256").update(sql).digest("hex") });
}
migrations.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
if (migrations.length > 1000) throw new Error("Manifest limit exceeded");
const manifest = { revision, migrations };
const digest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
process.stdout.write(JSON.stringify({ manifest, digest }, null, 2) + "\n");
