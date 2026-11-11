/** Poll saved state only. Undefined means the read failed; null is the server's
 * stop signal for a terminal or historical revision. Never pass a mutation here. */
export function startReadPolling(
  read: () => Promise<number | null | undefined>,
): () => void {
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = (seconds: number) => {
    timer = setTimeout(() => void poll(), seconds * 1000);
  };
  const poll = async () => {
    let seconds: number | null | undefined;
    try {
      seconds = await read();
    } catch {
      // Reading can be retried safely; dispatch/recovery commands cannot.
      seconds = undefined;
    }
    if (stopped || seconds === null) return;
    if (seconds === undefined) {
      failures++;
      schedule(Math.min(60, 10 * 2 ** Math.min(failures - 1, 3)));
    } else {
      failures = 0;
      schedule(Math.max(10, seconds));
    }
  };
  schedule(10);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
