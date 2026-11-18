// Worker-Pool: arbeitet Rezept-Aufträge im Hintergrund ab (höchstens `size` gleichzeitig in diesem Prozess).
// Läuft im selben Node-Prozess wie die API. Mehrere Pods wären auch sicher, weil jobs.ts Aufträge exklusiv vergibt.
import type { Job, JobStore } from './jobs';

export interface Workers {
  /** Sofort nach neuen Aufträgen schauen (nach dem Anlegen) */
  kick(): void;
  stop(): void;
}

export function startWorkers(jobs: JobStore, run: (job: Job) => Promise<void>, size: number, log: (m: string) => void = console.log): Workers {
  let active = 0;
  let stopped = false;

  const pump = async () => {
    while (!stopped && active < size) {
      active++;
      let job: Job | null = null;
      try {
        job = await jobs.claim();
      } catch (e) {
        log(`Warteschlange: ${String(e)}`);
      }
      if (!job) {
        active--;
        return;
      }
      const j = job;
      void run(j)
        .catch((e) => log(`Auftrag ${j.id} abgestürzt: ${String(e)}`))
        .finally(() => {
          active--;
          void pump();
        });
    }
  };

  const timer = setInterval(() => void pump(), 3000);
  void pump();
  return {
    kick: () => void pump(),
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
