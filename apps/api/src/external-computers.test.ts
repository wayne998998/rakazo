import type { SandboxProvider } from "@rakazo/adapter-kit";
import { createLogger, installLogger } from "@rakazo/logging";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  destroyExternalComputer,
  mountExternalComputerRoutes,
  normalizeExternalPath,
  observeExternalComputer,
  provisionExternalComputer,
  readExternalFile,
  runExternalBrowser,
  runExternalCommand,
  stopExternalComputer,
  writeExternalFile,
} from "./external-computers.js";

const TOKEN = "test-external-token";
const SPACE = "dsh-bridge";
const DATA_DIR = "/srv/rakazo/data";

function fakeProvider(overrides: Partial<SandboxProvider> = {}) {
  const calls = {
    provision: [] as Array<{ request: unknown; context: unknown }>,
    execute: [] as Array<{ request: unknown; context: unknown }>,
    readFile: [] as Array<{ path: string; context: unknown }>,
    writeFile: [] as Array<{ file: unknown; context: unknown }>,
    observe: [] as Array<{ context: unknown }>,
    browser: [] as Array<{ request: unknown; context: unknown }>,
    stop: 0,
    destroy: 0,
  };
  const provider = {
    describe: () => ({ id: "docker", contractVersion: "1", adapterVersion: "0.1.0", capabilities: {} }),
    provision: vi.fn(async (request: { botId: string }, context: unknown) => {
      calls.provision.push({ request, context });
      return { id: "container-1", botId: request.botId, kind: "docker", providerRef: "container-1", fresh: false };
    }),
    prepare: vi.fn(async () => undefined),
    execute: async function* (computer: unknown, request: unknown, context: unknown) {
      calls.execute.push({ request, context });
      yield { type: "stdout", data: "hello\n" };
      yield { type: "stderr", data: "warn\n" };
      yield { type: "exit", code: 3 };
    },
    observe: vi.fn(async (_computer: unknown, context: unknown) => {
      calls.observe.push({ context });
      return {
        frameId: "frame-1",
        capturedAt: new Date(0).toISOString(),
        mimeType: "image/png",
        image: Uint8Array.from([1, 2, 3, 4]),
        width: 1280,
        height: 800,
      };
    }),
    readFile: vi.fn(async (_computer: unknown, path: string, context: unknown) => {
      calls.readFile.push({ path, context });
      return new TextEncoder().encode("file-body");
    }),
    writeFile: vi.fn(async (_computer: unknown, file: unknown, context: unknown) => {
      calls.writeFile.push({ file, context });
    }),
    stop: vi.fn(async () => {
      calls.stop += 1;
    }),
    destroy: vi.fn(async () => {
      calls.destroy += 1;
    }),
    ...overrides,
  } as unknown as SandboxProvider;
  return { provider, calls };
}

const deps = (provider: SandboxProvider) => ({ sandbox: provider, dataDir: DATA_DIR, spaceId: SPACE });
const signal = new AbortController().signal;

beforeEach(() => {
  installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
});

describe("external computer contract", () => {
  it("derives the home path and pins the configured space", async () => {
    const { provider, calls } = fakeProvider();
    const result = await provisionExternalComputer(deps(provider), { botId: "dsh-abc123", signal });

    expect(result).toEqual({ id: "container-1", resumed: true });
    expect(calls.provision[0]?.request).toEqual({
      botId: "dsh-abc123",
      homePath: `${DATA_DIR}/homes/dsh-abc123`,
    });
    expect(calls.provision[0]?.context).toMatchObject({ spaceId: SPACE, botId: "dsh-abc123" });
  });

  it("rejects a caller-chosen identity that is not an identifier", async () => {
    const { provider } = fakeProvider();
    await expect(provisionExternalComputer(deps(provider), { botId: "../escape", signal })).rejects.toThrow(
      /botId must be an identifier/,
    );
  });

  it("runs a command in the workspace and reports streams and exit code", async () => {
    const { provider, calls } = fakeProvider();
    const result = await runExternalCommand(deps(provider), {
      id: "container-1",
      botId: "dsh-abc123",
      argv: ["bash", "-lc", "pwd"],
      cwd: "notes",
      timeoutMs: 30_000,
      signal,
    });

    expect(result).toEqual({ stdout: "hello\n", stderr: "warn\n", code: 3 });
    expect(calls.execute[0]?.request).toEqual({
      argv: ["bash", "-lc", "pwd"],
      cwd: "/home/rakazo/notes",
      timeoutMs: 30_000,
    });
  });

  it("rejects traversal, empty argv, and unbounded timeouts", async () => {
    const { provider } = fakeProvider();
    const base = { id: "container-1", botId: "dsh-abc123", signal };
    await expect(
      runExternalCommand(deps(provider), { ...base, argv: ["/bin/true"], cwd: "../../etc" }),
    ).rejects.toThrow(/escapes the computer workspace/);
    await expect(runExternalCommand(deps(provider), { ...base, argv: [] })).rejects.toThrow(/non-empty string array/);
    await expect(
      runExternalCommand(deps(provider), { ...base, argv: ["/bin/true"], timeoutMs: 10 ** 9 }),
    ).rejects.toThrow(/timeoutMs must be an integer/);
    expect(normalizeExternalPath("/notes//a.txt")).toBe("notes/a.txt");
  });

  it("encodes file reads and decodes file writes as base64", async () => {
    const { provider, calls } = fakeProvider();
    const read = await readExternalFile(deps(provider), {
      id: "container-1",
      botId: "dsh-abc123",
      path: "notes/a.txt",
      signal,
    });
    expect(Buffer.from(read.content, "base64").toString("utf8")).toBe("file-body");
    expect(calls.readFile[0]?.path).toBe("notes/a.txt");

    await writeExternalFile(deps(provider), {
      id: "container-1",
      botId: "dsh-abc123",
      path: "notes/b.txt",
      content: Buffer.from("written", "utf8").toString("base64"),
      executable: true,
      signal,
    });
    const written = calls.writeFile[0]?.file as { path: string; executable?: boolean; content: Uint8Array };
    expect(written.path).toBe("notes/b.txt");
    expect(written.executable).toBe(true);
    expect(Buffer.from(written.content).toString("utf8")).toBe("written");
  });

  it("returns an observation as base64 image data", async () => {
    const { provider } = fakeProvider();
    const observation = await observeExternalComputer(deps(provider), {
      id: "container-1",
      botId: "dsh-abc123",
      signal,
    });
    expect(observation).toEqual({ image: "AQIDBA==", mimeType: "image/png", width: 1280, height: 800 });
  });

  it("reports a missing browser capability instead of failing silently", async () => {
    const { provider } = fakeProvider();
    await expect(
      runExternalBrowser(deps(provider), {
        id: "container-1",
        botId: "dsh-abc123",
        command: "snapshot",
        payload: { command: "snapshot" },
        signal,
      }),
    ).rejects.toThrow(/no browser/);
  });

  it("delegates stop and destroy", async () => {
    const { provider, calls } = fakeProvider();
    const base = { id: "container-1", botId: "dsh-abc123", signal };
    await stopExternalComputer(deps(provider), base);
    await destroyExternalComputer(deps(provider), base);
    expect([calls.stop, calls.destroy]).toEqual([1, 1]);
  });

  it("carries a supplied screen id into the provider context", async () => {
    const { provider, calls } = fakeProvider();
    await observeExternalComputer(deps(provider), {
      id: "container-1",
      botId: "dsh-abc123",
      screenId: "dsh-abc123-writer",
      signal,
    });
    expect(calls.observe[0]?.context).toMatchObject({
      botId: "dsh-abc123",
      screenId: "dsh-abc123-writer",
    });
  });

  it("rejects a malformed screen id", async () => {
    const { provider } = fakeProvider();
    await expect(
      observeExternalComputer(deps(provider), {
        id: "container-1",
        botId: "dsh-abc123",
        screenId: "bad/slash",
        signal,
      }),
    ).rejects.toThrow(/screenId must be an identifier/);
  });

  it("refuses a screen id that does not belong to the caller's computer", async () => {
    const { provider } = fakeProvider();
    await expect(
      observeExternalComputer(deps(provider), {
        id: "container-1",
        botId: "dsh-abc123",
        screenId: "dsh-other-writer",
        signal,
      }),
    ).rejects.toThrow(/screenId does not belong to this computer/);
  });
});

describe("external computer routes", () => {
  function app(provider: SandboxProvider, token = TOKEN) {
    const instance = new Hono();
    mountExternalComputerRoutes(instance, deps(provider), { token });
    return instance;
  }

  it("mounts nothing when the integration is unconfigured", async () => {
    const { provider } = fakeProvider();
    const response = await app(provider, "").request("/api/v1/external/computers", { method: "POST" });
    expect(response.status).toBe(404);
  });

  it("requires the service token", async () => {
    const { provider } = fakeProvider();
    const unauthorized = await app(provider).request("/api/v1/external/computers", { method: "POST" });
    expect(unauthorized.status).toBe(401);
    const wrong = await app(provider).request("/api/v1/external/computers", {
      method: "POST",
      headers: { authorization: "Bearer other" },
    });
    expect(wrong.status).toBe(401);
  });

  it("provisions and executes over HTTP", async () => {
    const { provider, calls } = fakeProvider();
    const instance = app(provider);
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

    const created = await instance.request("/api/v1/external/computers", {
      method: "POST",
      headers,
      body: JSON.stringify({ botId: "dsh-abc123" }),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ id: "container-1", resumed: true });

    const exec = await instance.request("/api/v1/external/computers/container-1/exec", {
      method: "POST",
      headers: { ...headers, "x-rakazo-bot-id": "dsh-abc123" },
      body: JSON.stringify({ argv: ["/bin/true"] }),
    });
    expect(exec.status).toBe(200);
    expect(await exec.json()).toEqual({ stdout: "hello\n", stderr: "warn\n", code: 3 });

    const missingIdentity = await instance.request("/api/v1/external/computers/container-1/exec", {
      method: "POST",
      headers,
      body: JSON.stringify({ argv: ["/bin/true"] }),
    });
    expect(missingIdentity.status).toBe(400);
    expect(calls.execute).toHaveLength(1);
  });

  it("normalizes a missing container to 404 and other provider failures to 502", async () => {
    const missing = fakeProvider({
      stop: vi.fn(async () => {
        throw new Error("sandbox stop failed: 404 computer not found");
      }) as unknown as SandboxProvider["stop"],
    });
    const missingResponse = await app(missing.provider).request("/api/v1/external/computers/container-1/stop", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "x-rakazo-bot-id": "dsh-abc123" },
    });
    expect(missingResponse.status).toBe(404);

    const unreachable = fakeProvider({
      stop: vi.fn(async () => {
        throw new Error("supervisor unreachable: connect ECONNREFUSED");
      }) as unknown as SandboxProvider["stop"],
    });
    const gateway = await app(unreachable.provider).request("/api/v1/external/computers/container-1/stop", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "x-rakazo-bot-id": "dsh-abc123" },
    });
    expect(gateway.status).toBe(502);
    expect(await gateway.json()).toEqual({ error: "supervisor unreachable: connect ECONNREFUSED" });
  });

  it("threads a valid screen id into the provider context over HTTP", async () => {
    const { provider, calls } = fakeProvider();
    const instance = app(provider);
    const response = await instance.request("/api/v1/external/computers/container-1/observe", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-rakazo-bot-id": "dsh-abc123",
        "x-rakazo-screen-id": "dsh-abc123-writer",
      },
    });
    expect(response.status).toBe(200);
    expect(calls.observe[0]?.context).toMatchObject({ screenId: "dsh-abc123-writer" });
  });

  it("rejects a malformed screen id with 400", async () => {
    const { provider } = fakeProvider();
    const response = await app(provider).request("/api/v1/external/computers/container-1/observe", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-rakazo-bot-id": "dsh-abc123",
        "x-rakazo-screen-id": "bad/slash",
      },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "screenId must be an identifier" });
  });

  it("refuses a screen id that does not belong to the caller's computer", async () => {
    const { provider } = fakeProvider();
    const response = await app(provider).request("/api/v1/external/computers/container-1/observe", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-rakazo-bot-id": "dsh-abc123",
        "x-rakazo-screen-id": "dsh-other-writer",
      },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "screenId does not belong to this computer" });
  });
});
