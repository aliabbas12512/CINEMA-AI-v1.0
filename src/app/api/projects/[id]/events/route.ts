import { getDb } from "@/server/db/client";
import { handler, requireUser } from "@/server/http/api";
import { getOwnedProject } from "@/server/services/projects";
import { getProjectStatus } from "@/server/services/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "PAUSED", "DRAFT"]);

/**
 * Server-Sent Events stream of REAL backend state. The server re-reads the
 * database every 1.5s and emits only when something changed.
 */
export const GET = handler(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await params;
  await getOwnedProject(getDb(), user.id, id);
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let last = "";
      let idleTicks = 0;
      const tick = async () => {
        if (closed) return;
        try {
          const status = await getProjectStatus(getDb(), id);
          const payload = JSON.stringify(status);
          if (payload !== last) {
            controller.enqueue(encoder.encode(`event: status\ndata: ${payload}\n\n`));
            last = payload;
            idleTicks = 0;
          } else if (++idleTicks % 10 === 0) {
            controller.enqueue(encoder.encode(`: keep-alive\n\n`));
          }
          // Stay open on terminal states briefly, then let the client reconnect if needed.
          if (TERMINAL.has(status.status) && idleTicks > 20) {
            closed = true;
            controller.close();
            return;
          }
        } catch {
          controller.enqueue(encoder.encode(`event: error\ndata: {"error":"status unavailable"}\n\n`));
        }
        timer = setTimeout(() => void tick(), 1500);
      };
      void tick();
      req.signal.addEventListener("abort", () => {
        closed = true;
        if (timer) clearTimeout(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
