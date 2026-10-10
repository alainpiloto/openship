import { Type, type Static } from "@sinclair/typebox";

export const MigrationStatusInput = Type.Object(
  {
    revision: Type.String({ pattern: "^[a-f0-9]{40}$" }),
  },
  { additionalProperties: false },
);
const nullableString = Type.Union([Type.String(), Type.Null()]);
const count = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);
export const MigrationStatusOutput = Type.Object(
  {
    projectId: Type.String(),
    organizationId: Type.String(),
    status: Type.Union([
      Type.Literal("UP_TO_DATE"),
      Type.Literal("PENDING"),
      Type.Literal("FAILED"),
      Type.Literal("DIVERGED"),
      Type.Literal("UNKNOWN"),
    ]),
    revision: Type.String(),
    deploymentId: nullableString,
    activeRevision: nullableString,
    manifestDigest: nullableString,
    checkedAt: Type.String(),
    counts: Type.Object({
      expected: count,
      applied: count,
      pending: count,
      failed: count,
      divergent: count,
    }),
    reason: Type.Union([
      Type.Literal("COMPLETE"),
      Type.Literal("PROFILE_UNAVAILABLE"),
      Type.Literal("MANIFEST_UNAVAILABLE"),
      Type.Literal("BUSY"),
      Type.Literal("INDETERMINATE"),
    ]),
  },
  { additionalProperties: false },
);
export type ProjectMigrationStatus = Static<typeof MigrationStatusOutput>;
export const ProjectMigrationSchemas = {
  getMigrationStatus: {
    action: "read",
    input: MigrationStatusInput,
    output: MigrationStatusOutput,
  },
} as const;
