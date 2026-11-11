import { useEffect, useRef, useState } from "react";

export function useMotionPreference() {
  const [requested, setRequested] = useState(() => {
    try {
      return localStorage.getItem("mf-motion") !== "off";
    } catch {
      return true;
    }
  });
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => setReduced(media.matches);
    changed();
    media.addEventListener("change", changed);
    const stored = (event: StorageEvent) => {
      if (event.key === "mf-motion" || event.key === null)
        setRequested(event.newValue !== "off");
    };
    window.addEventListener("storage", stored);
    return () => {
      media.removeEventListener("change", changed);
      window.removeEventListener("storage", stored);
    };
  }, []);
  const change = (value: boolean) => {
    setRequested(value);
    try {
      localStorage.setItem("mf-motion", value ? "on" : "off");
    } catch {
      /* Preferences are optional in restricted WebViews. */
    }
  };
  return { enabled: requested && !reduced, reduced, change };
}

/** Fifteen small CSS transforms, two finite cycles; never a JS rendering loop. */
export function MotionMark({ enabled }: { enabled: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [replay, setReplay] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let inView = false;
    const update = () => {
      node.dataset.running = String(
        enabled && inView && document.visibilityState !== "hidden",
      );
    };
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      update();
    });
    update();
    observer.observe(node);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      node.dataset.running = "false";
    };
  }, [enabled]);
  return (
    <button
      ref={ref}
      type="button"
      className="mf-motion-mark"
      disabled={!enabled}
      aria-label={enabled ? "重播圆点动效" : "圆点装饰（静态）"}
      title={enabled ? "点击重播动效" : "静态显示"}
      onClick={() => setReplay((n) => n + 1)}
    >
      <span className="mf-dot-field" key={replay} aria-hidden="true">
        {Array.from({ length: 15 }, (_, i) => (
          <span
            className="mf-dot"
            key={i}
            style={{
              animationDelay: `${(i % 5) * 90 + Math.floor(i / 5) * 110}ms`,
            }}
          />
        ))}
      </span>
    </button>
  );
}
