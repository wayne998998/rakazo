import { randomUUID, timingSafeEqual } from "node:crypto";
import type {
  AdapterContext,
  ComputerRef,
  PageBrowserCommand,
  PageBrowserResult,
  PortableFile,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { Context, Hono } from "hono";
import { getLogger } from "@rakazo/logging";
import { requestBodyLimit } from "./request-body-limit.js";

/**
 * Service-account computer access for an external agent harness.
 *
 * This is the only supported way for a program outside Rakazo to obtain a
 * computer: the harness never receives the sandbox supervisor URL or token, and
 * every call here is re-authorized against the operator-configured space. The
 * caller names a bot identity, and the sandbox provider's own identity checks
 * reject a container that identity does not own, so a caller cannot widen its
 * reach by naming someone else's computer. A caller may additionally name a
 * screen identity (`x-rakazo-screen-id`) to get its own display on that shared
 * computer; screen ids are namespaced under the caller's botId so a caller can
 * never address another computer's display.
 *
 * Disabled unless both the token and the space are configured.
 */

const EXTERNAL_BOT_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
/** The subject recorded for every external operation; there is no signed-in user. */
const EXTERNAL_USER_ID = "external-computer-service";

export interface ExternalComputerDeps {
  sandbox: SandboxProvider;
  dataDir: string;
  /** Operator-configured space that owns every computer created through this API. */
  spaceId: string;
}

/** Status codes this surface returns; narrowed so Hono's response typing holds. */
type ExternalStatus = 400 | 401 | 403 | 404 | 409 | 413 | 501 | 502;

class ExternalRequestError extends Error {
  constructor(
    readonly status: ExternalStatus,
    message: string,
  ) {
    super(message);
  }
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !EXTERNAL_BOT_PREFIX.test(value)) {
    throw new ExternalRequestError(400, `${name} must be an identifier`);
  }
  return value;
}

/**
 * Resolves the screen identity for a caller's botId. The display is keyed by
 * `screenId ?? botId`, so a caller may only name a screen whose key belongs to
 * the computer its supplied botId owns: the screen id must be the botId itself
 * or an extension of it (e.g. `botId-writer`). This stops a caller from
 * addressing another computer's display and keeps screen keys namespaced per
 * computer; the supervisor's team screen limit still bounds the screen count.
 */
function screenIdFor(botId: string, screenId: unknown): string | undefined {
  if (screenId === undefined) return undefined;
  const value = identifier(screenId, "screenId");
  if (value !== botId && !value.startsWith(`${botId}-`)) {
    throw new ExternalRequestError(403, "screenId does not belong to this computer");
  }
  return value;
}

/** Workspace-relative path; absolute paths and lexical traversal are rejected. */
export function normalizeExternalPath(value: unknown): string {
  if (typeof value !== "string") throw new ExternalRequestError(400, "path must be a string");
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new ExternalRequestError(400, "path escapes the computer workspace");
  }
  return segments.join("/");
}

function commandArgv(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item)) {
    throw new ExternalRequestError(400, "argv must be a non-empty string array");
  }
  return value as string[];
}

function commandTimeout(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < MIN_TIMEOUT_MS || (value as number) > MAX_TIMEOUT_MS) {
    throw new ExternalRequestError(400, `timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return value as number;
}

function contextFor(
  deps: ExternalComputerDeps,
  botId: string,
  screenId: string | undefined,
  signal: AbortSignal,
): AdapterContext {
  return {
    operationId: `external-computer:${randomUUID()}`,
    traceId: `external-computer:${botId}`,
    spaceId: deps.spaceId,
    userId: EXTERNAL_USER_ID,
    botId,
    ...(screenId ? { screenId } : {}),
    signal,
  };
}

function refFor(id: string, botId: string): ComputerRef {
  return { id, botId, kind: "docker", providerRef: id, fresh: false };
}

/** The home is derived here, never accepted from the caller. */
export function externalHomePath(deps: ExternalComputerDeps, botId: string): string {
  return `${deps.dataDir.replace(/\/$/, "")}/homes/${botId}`;
}

export async function provisionExternalComputer(
  deps: ExternalComputerDeps,
  input: { botId: unknown; signal: AbortSignal },
): Promise<{ id: string; resumed: boolean }> {
  const botId = identifier(input.botId, "botId");
  const computer = await deps.sandbox.provision(
    { botId, homePath: externalHomePath(deps, botId) },
    contextFor(deps, botId, undefined, input.signal),
  );
  await deps.sandbox.prepare(computer, contextFor(deps, botId, undefined, input.signal));
  return { id: computer.id, resumed: computer.fresh !== true };
}

export async function runExternalCommand(
  deps: ExternalComputerDeps,
  input: { id: string; botId: unknown; screenId?: unknown; argv: unknown; cwd: unknown; timeoutMs: unknown; signal: AbortSignal },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const botId = identifier(input.botId, "botId");
  const screenId = screenIdFor(botId, input.screenId);
  const relative = input.cwd === undefined ? "" : normalizeExternalPath(input.cwd);
  const request = {
    argv: commandArgv(input.argv),
    cwd: relative ? `/home/rakazo/${relative}` : "/home/rakazo",
    timeoutMs: commandTimeout(input.timeoutMs),
  };
  let stdout = "";
  let stderr = "";
  let code = 0;
  for await (const event of deps.sandbox.execute(
    refFor(input.id, botId),
    request,
    contextFor(deps, botId, screenId, input.signal),
  )) {
    if (event.type === "stdout") stdout += event.data;
    else if (event.type === "stderr") stderr += event.data;
    else code = event.code;
  }
  return { stdout, stderr, code };
}

export async function readExternalFile(
  deps: ExternalComputerDeps,
  input: { id: string; botId: unknown; screenId?: unknown; path: unknown; signal: AbortSignal },
): Promise<{ content: string }> {
  const botId = identifier(input.botId, "botId");
  const screenId = screenIdFor(botId, input.screenId);
  const path = normalizeExternalPath(input.path);
  const bytes = await deps.sandbox.readFile(refFor(input.id, botId), path, contextFor(deps, botId, screenId, input.signal), {
    maxBytes: MAX_FILE_BYTES,
  });
  return { content: Buffer.from(bytes).toString("base64") };
}

export async function writeExternalFile(
  deps: ExternalComputerDeps,
  input: {
    id: string;
    botId: unknown;
    screenId?: unknown;
    path: unknown;
    content: unknown;
    executable: unknown;
    signal: AbortSignal;
  },
): Promise<{ ok: true }> {
  const botId = identifier(input.botId, "botId");
  const screenId = screenIdFor(botId, input.screenId);
  const path = normalizeExternalPath(input.path);
  if (typeof input.content !== "string") throw new ExternalRequestError(400, "content must be base64 text");
  const bytes = Buffer.from(input.content, "base64");
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new ExternalRequestError(400, "content exceeds the 16 MiB limit");
  }
  const file: PortableFile = { path, content: bytes, executable: input.executable === true };
  await deps.sandbox.writeFile(refFor(input.id, botId), file, contextFor(deps, botId, screenId, input.signal));
  return { ok: true };
}

export async function observeExternalComputer(
  deps: ExternalComputerDeps,
  input: { id: string; botId: unknown; screenId?: unknown; signal: AbortSignal },
): Promise<{ image: string; mimeType: string; width: number; height: number }> {
  const botId = identifier(input.botId, "botId");
  const screenId = screenIdFor(botId, input.screenId);
  const observation = await deps.sandbox.observe(refFor(input.id, botId), contextFor(deps, botId, screenId, input.signal));
  return {
    image: Buffer.from(observation.image).toString("base64"),
    mimeType: observation.mimeType,
    width: observation.width,
    height: observation.height,
  };
}

export async function runExternalBrowser(
  deps: ExternalComputerDeps,
  input: { id: string; botId: unknown; screenId?: unknown; command: unknown; payload: Record<string, unknown>; signal: AbortSignal },
): Promise<PageBrowserResult> {
  const botId = identifier(input.botId, "botId");
  const screenId = screenIdFor(botId, input.screenId);
  const pageBrowser = deps.sandbox.pageBrowser?.bind(deps.sandbox);
  if (!pageBrowser) throw new ExternalRequestError(501, "this sandbox provider has no browser");
  const command = input.command;
  if (command !== "navigate" && command !== "snapshot" && command !== "act") {
    throw new ExternalRequestError(400, "command must be navigate, snapshot, or act");
  }
  return pageBrowser(
    refFor(input.id, botId),
    input.payload as unknown as PageBrowserCommand,
    contextFor(deps, botId, screenId, input.signal),
  );
}

export async function stopExternalComputer(
  deps: ExternalComputerDeps,
  input: { id: string; botId: unknown; screenId?: unknown; signal: AbortSignal },
): Promise<{ ok: true }> {
  const botId = identifier(input.botId, "botId");
  const screenId = screenIdFor(botId, input.screenId);
  await deps.sandbox.stop(refFor(input.id, botId), contextFor(deps, botId, screenId, input.signal));
  return { ok: true };
}

export async function destroyExternalComputer(
  deps: ExternalComputerDeps,
  input: { id: string; botId: unknown; screenId?: unknown; signal: AbortSignal },
): Promise<{ ok: true }> {
  const botId = identifier(input.botId, "botId");
  const screenId = screenIdFor(botId, input.screenId);
  await deps.sandbox.destroy(refFor(input.id, botId), contextFor(deps, botId, screenId, input.signal));
  return { ok: true };
}

function authorized(supplied: string | undefined, token: string): boolean {
  const provided = Buffer.from(supplied ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * Mount the external computer routes. Returns without mounting when the feature
 * is unconfigured, so an unconfigured deployment exposes no surface at all.
 */
export function mountExternalComputerRoutes(
  app: Hono,
  deps: ExternalComputerDeps,
  config: { token: string | undefined },
): void {
  const token = config.token;
  if (!token || !deps.spaceId) return;
  const logger = getLogger();
  const limit = requestBodyLimit(MAX_BODY_BYTES);

  app.use("/api/v1/external/computers", limit);
  app.use("/api/v1/external/computers/*", limit);
  app.use("/api/v1/external/computers", async (c, next) => {
    if (!authorized(c.req.header("authorization"), token)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  app.use("/api/v1/external/computers/*", async (c, next) => {
    if (!authorized(c.req.header("authorization"), token)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  const finish = async (c: Context, work: () => Promise<unknown>) => {
    c.header("cache-control", "no-store");
    try {
      return c.json(await work());
    } catch (error) {
      if (error instanceof ExternalRequestError) return c.json({ error: error.message }, error.status);
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("external computer request failed", { "external.error": message });
      // A provider reports a missing container as an error whose message carries
      // its own 404. Callers need that as a status, so it is normalized here.
      // A provider that reports its own status keeps it: a rejected request is
      // the caller's to fix, and must not read as a server fault.
      const reported = (error as { status?: unknown } | null)?.status;
      const status: ExternalStatus =
        typeof reported === "number" && reported >= 400 && reported < 500
          ? (reported as ExternalStatus)
          : /\b404\b|not found/i.test(message)
            ? 404
            : 502;
      return c.json({ error: message }, status);
    }
  };

  app.post("/api/v1/external/computers", (c) =>
    finish(c, async () => {
      const body = await c.req.json().catch(() => ({}));
      const result = await provisionExternalComputer(deps, {
        botId: body?.botId,
        signal: c.req.raw.signal,
      });
      logger.info("external computer provisioned", { "external.computerId": result.id, "space.id": deps.spaceId });
      return result;
    }),
  );

  app.post("/api/v1/external/computers/:id/exec", (c) =>
    finish(c, async () => {
      const body = await c.req.json().catch(() => ({}));
      const result = await runExternalCommand(deps, {
        id: c.req.param("id"),
        botId: c.req.header("x-rakazo-bot-id"),
        screenId: c.req.header("x-rakazo-screen-id"),
        argv: body?.argv,
        cwd: body?.cwd,
        timeoutMs: body?.timeoutMs,
        signal: c.req.raw.signal,
      });
      logger.info("external computer command", {
        "external.computerId": c.req.param("id"),
        "external.code": result.code,
      });
      return result;
    }),
  );

  app.get("/api/v1/external/computers/:id/files", (c) =>
    finish(c, () =>
      readExternalFile(deps, {
        id: c.req.param("id"),
        botId: c.req.header("x-rakazo-bot-id"),
        screenId: c.req.header("x-rakazo-screen-id"),
        path: c.req.query("path") ?? "",
        signal: c.req.raw.signal,
      }),
    ),
  );

  app.post("/api/v1/external/computers/:id/files", (c) =>
    finish(c, async () => {
      const body = await c.req.json().catch(() => ({}));
      return writeExternalFile(deps, {
        id: c.req.param("id"),
        botId: c.req.header("x-rakazo-bot-id"),
        screenId: c.req.header("x-rakazo-screen-id"),
        path: body?.path,
        content: body?.content,
        executable: body?.executable,
        signal: c.req.raw.signal,
      });
    }),
  );

  app.post("/api/v1/external/computers/:id/observe", (c) =>
    finish(c, () =>
      observeExternalComputer(deps, {
        id: c.req.param("id"),
        botId: c.req.header("x-rakazo-bot-id"),
        screenId: c.req.header("x-rakazo-screen-id"),
        signal: c.req.raw.signal,
      }),
    ),
  );

  app.post("/api/v1/external/computers/:id/browser", (c) =>
    finish(c, async () => {
      const body = await c.req.json().catch(() => ({}));
      return runExternalBrowser(deps, {
        id: c.req.param("id"),
        botId: c.req.header("x-rakazo-bot-id"),
        screenId: c.req.header("x-rakazo-screen-id"),
        command: body?.command,
        payload: body ?? {},
        signal: c.req.raw.signal,
      });
    }),
  );

  app.post("/api/v1/external/computers/:id/stop", (c) =>
    finish(c, () =>
      stopExternalComputer(deps, {
        id: c.req.param("id"),
        botId: c.req.header("x-rakazo-bot-id"),
        screenId: c.req.header("x-rakazo-screen-id"),
        signal: c.req.raw.signal,
      }),
    ),
  );

  app.delete("/api/v1/external/computers/:id", (c) =>
    finish(c, () =>
      destroyExternalComputer(deps, {
        id: c.req.param("id"),
        botId: c.req.header("x-rakazo-bot-id"),
        screenId: c.req.header("x-rakazo-screen-id"),
        signal: c.req.raw.signal,
      }),
    ),
  );
}
