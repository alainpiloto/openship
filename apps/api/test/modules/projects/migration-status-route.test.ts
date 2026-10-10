import { describe, expect, it } from "vitest";
import { getRouteRegistry, isPublicSpec } from "../../../src/lib/route-permission";
import "../../../src/modules/projects/project.routes";
describe("migration status route", () => {
  it("uses project read on self-hosted HTTP and does not weaken exec routes", () => {
    const route = getRouteRegistry().find(
      (r) => r.method === "GET" && r.path === "/api/projects/:id/migration-status",
    );
    expect(route).toBeTruthy();
    if (!route || isPublicSpec(route.spec)) throw new Error("missing protected route");
    expect(route.spec.tag).toBe("project:read");
    expect(route.spec.localOnly).toBe(true);
    const exec = getRouteRegistry().find(
      (r) => r.path === "/api/projects/:id/services/:serviceId/exec",
    );
    if (exec && !isPublicSpec(exec.spec)) expect(exec.spec.tag).toBe("project:service:write");
  });
});
