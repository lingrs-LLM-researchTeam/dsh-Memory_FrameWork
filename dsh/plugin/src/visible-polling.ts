/** UI polling only. Host revocation/admission checks retain their own cadence. */
export function startVisiblePolling(
  refresh: (signal: AbortSignal) => Promise<void>,
  onError: (error: unknown) => void,
  surface: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  > = document,
  delay = 10000,
) {
  let stopped = false;
  let pending = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visible = () => surface.visibilityState !== "hidden";
  const poll = async () => {
    if (stopped || pending || !visible()) return;
    pending = true;
    const request = new AbortController();
    controller = request;
    try {
      await refresh(request.signal);
    } catch (error) {
      if (!request.signal.aborted) onError(error);
    } finally {
      pending = false;
      if (!stopped && visible())
        timer = setTimeout(poll, request.signal.aborted ? 0 : delay);
    }
  };
  const changed = () => {
    clearTimeout(timer);
    if (surface.visibilityState === "hidden") controller?.abort();
    else void poll();
  };
  surface.addEventListener("visibilitychange", changed);
  void poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
    surface.removeEventListener("visibilitychange", changed);
  };
}
