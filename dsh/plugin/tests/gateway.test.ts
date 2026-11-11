import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import TypertRegistry from "@deepseek-ai/dsh-typert-registry";
import RemoteAccess from "@deepseek-ai/dsh-api-remote-access";
import Gateway from "@deepseek-ai/dsh-api-gateway";
import { Peer } from "@deepseek-ai/dsh-client-connection";
import { installGateway } from "../.compiled/gateway.js";

declare module "@deepseek-ai/dsh-typert-protocol" {
  interface PrincipalMap {
    "memory-test-guest": { kind: "memory-test-guest" };
  }
}

describe("real DSH gateway authentication and contracts", () => {
  it("accepts owner commands, rejects spoofed and unauthenticated callers", async () => {
    const ctx = new Context();
    try {
      await ctx.plugin(TypertRegistry);
      await ctx.plugin(RemoteAccess);
      await ctx.plugin(Gateway);
      const received: unknown[] = [];
      await installGateway(ctx, async (request) => {
        received.push(request);
        return { result: { operation: request.operation } };
      });
      const owner = new Peer(ctx, { principal: { kind: "owner" } });
      const guest = new Peer(ctx, { principal: { kind: "memory-test-guest" } });
      const invoke = (peer: Peer, request: unknown) =>
        ctx.typertGateway.invoke({
          peer,
          namespace: "memoryFramework",
          method: "command",
          args: { request },
        });
      expect(await invoke(owner, { operation: "snapshot" })).toEqual({
        result: { operation: "snapshot" },
      });
      await expect(invoke(owner, { operation: 12 })).rejects.toMatchObject({
        code: "gateway/input-invalid",
      });
      await expect(
        invoke(owner, { operation: "snapshot", principal: { kind: "owner" } }),
      ).rejects.toMatchObject({ code: "gateway/input-invalid" });
      await expect(
        invoke(guest, { operation: "snapshot" }),
      ).rejects.toMatchObject({ code: "remote-access/denied" });
      await owner.dispose();
      await expect(
        invoke(owner, { operation: "snapshot" }),
      ).rejects.toMatchObject({ code: "gateway/peer-disposed" });
      expect(received).toHaveLength(1);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
