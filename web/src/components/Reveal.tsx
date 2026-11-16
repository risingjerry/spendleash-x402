"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/** Adds `.in` to every [data-reveal] element as it scrolls into view (blur-fade entrance). */
export function Reveal() {
  const pathname = usePathname();
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]:not(.in)"));
    if (!("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          const delay = Number(el.dataset.reveal || 0);
          setTimeout(() => el.classList.add("in"), delay);
          io.unobserve(el);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [pathname]);
  return null;
}
