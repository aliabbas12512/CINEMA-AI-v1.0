import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createSession, destroySession, getSessionUser } from "@/server/auth/session";
import { rateLimit } from "@/server/auth/rate-limit";
import { closeDb, getDb } from "@/server/db/client";
import { projects, scripts, shots } from "@/server/db/schema";
import { closeQueue, getRedis } from "@/server/pipeline/queue";
import { login, signup } from "@/server/services/auth";
import { createProject, getOwnedProject, listProjects, requestControl, retryShot, ServiceError, startGeneration } from "@/server/services/projects";
import { createUser, resetDatabase, SAMPLE_SCRIPT } from "../helpers";

const db = () => getDb();

describe("auth, authorization and job creation", () => {
  beforeEach(resetDatabase);
  afterAll(async () => {
    await closeQueue();
    await closeDb();
  });

  it("signs up, logs in, and manages sessions", async () => {
    const u = await signup(db(), { email: "a@example.com", password: "long-password-1" });
    await expect(signup(db(), { email: "a@example.com", password: "long-password-1" })).rejects.toThrow(/already exists/);
    await expect(login(db(), { email: "a@example.com", password: "nope" })).rejects.toThrow(/Invalid email or password/);
    await expect(login(db(), { email: "missing@example.com", password: "nope" })).rejects.toThrow(/Invalid email or password/);
    expect((await login(db(), { email: "a@example.com", password: "long-password-1" })).id).toBe(u.id);
    const { token } = await createSession(db(), u.id);
    expect((await getSessionUser(db(), token))?.email).toBe("a@example.com");
    expect(await getSessionUser(db(), "forged-token")).toBeNull();
    await destroySession(db(), token);
    expect(await getSessionUser(db(), token)).toBeNull();
  });

  it("creates a project with a versioned script and validated settings", async () => {
    const u = await createUser();
    const p = await createProject(db(), u.id, { script: SAMPLE_SCRIPT, settings: { visualStyle: "dark_fantasy" } }, 60_000);
    expect(p.status).toBe("DRAFT");
    expect(p.settings.visualStyle).toBe("dark_fantasy");
    expect(p.settings.targetDurationSec).toBe(600);
    const [s] = await db().select().from(scripts).where(eq(scripts.projectId, p.id));
    expect(s?.version).toBe(1);
    await expect(createProject(db(), u.id, { script: "too short" }, 60_000)).rejects.toThrow(/at least 200/);
    await expect(createProject(db(), u.id, { script: SAMPLE_SCRIPT, settings: { resolution: "8k" } }, 60_000)).rejects.toBeInstanceOf(ServiceError);
    await expect(createProject(db(), u.id, { script: SAMPLE_SCRIPT }, 100)).rejects.toThrow(/exceeds/);
  });

  it("enforces ownership on every project operation", async () => {
    const owner = await createUser();
    const intruder = await createUser();
    const p = await createProject(db(), owner.id, { script: SAMPLE_SCRIPT }, 60_000);
    await expect(getOwnedProject(db(), intruder.id, p.id)).rejects.toMatchObject({ status: 404 });
    await expect(startGeneration(db(), intruder.id, p.id, async () => undefined)).rejects.toMatchObject({ status: 404 });
    await expect(requestControl(db(), intruder.id, p.id, "cancel")).rejects.toMatchObject({ status: 404 });
    await expect(getOwnedProject(db(), owner.id, "not-a-uuid")).rejects.toMatchObject({ status: 404 });
    expect(await listProjects(db(), intruder.id)).toHaveLength(0);
    expect(await listProjects(db(), owner.id)).toHaveLength(1);
  });

  it("creates exactly one queued job per run and refuses concurrent runs", async () => {
    const u = await createUser();
    const p = await createProject(db(), u.id, { script: SAMPLE_SCRIPT }, 60_000);
    const enqueued: Array<[string, number]> = [];
    const { run } = await startGeneration(db(), u.id, p.id, async (id, r) => void enqueued.push([id, r]));
    expect(run).toBe(1);
    expect(enqueued).toEqual([[p.id, 1]]);
    const [row] = await db().select().from(projects).where(eq(projects.id, p.id));
    expect(row?.status).toBe("QUEUED");
    await expect(startGeneration(db(), u.id, p.id, async () => undefined)).rejects.toMatchObject({ status: 409 });
    // pause/cancel are requests the worker must confirm
    await requestControl(db(), u.id, p.id, "pause");
    const [after] = await db().select().from(projects).where(eq(projects.id, p.id));
    expect(after?.control).toBe("pause_requested");
    expect(after?.status).toBe("QUEUED");
  });

  it("never leaves a project QUEUED when the queue is unreachable", async () => {
    const u = await createUser();
    const p = await createProject(db(), u.id, { script: SAMPLE_SCRIPT }, 60_000);
    await expect(startGeneration(db(), u.id, p.id, async () => { throw new Error("ECONNREFUSED"); })).rejects.toMatchObject({ status: 503 });
    const [row] = await db().select().from(projects).where(eq(projects.id, p.id));
    expect(row?.status).toBe("FAILED");
  });

  it("retryShot rejects shots from other projects", async () => {
    const u = await createUser();
    const p = await createProject(db(), u.id, { script: SAMPLE_SCRIPT }, 60_000);
    await expect(retryShot(db(), u.id, p.id, "00000000-0000-0000-0000-000000000000", { regenerateKeyframe: false }, async () => undefined)).rejects.toMatchObject({ status: 404 });
    expect(await db().select().from(shots)).toHaveLength(0);
  });

  it("rate limiter blocks after the limit within a window", async () => {
    const key = `test:${Date.now()}`;
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await rateLimit(getRedis(), key, 3, 60)).allowed);
    expect(results).toEqual([true, true, true, false]);
  });
});
