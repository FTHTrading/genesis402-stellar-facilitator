import type { createDiscoveryApp } from "../src/app.js";

export const publicResolver = async () => ["93.184.216.34"];

export async function waitForJob(
  app: ReturnType<typeof createDiscoveryApp>,
  id: string,
): Promise<{ status: string; error?: string; listed?: number }> {
  for (let i = 0; i < 100; i++) {
    const res = await app.request(`/discovery/jobs/${id}`);
    const job = (await res.json()) as { status: string; error?: string; listed?: number };
    if (job.status === "done" || job.status === "failed") return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("job did not finish");
}
