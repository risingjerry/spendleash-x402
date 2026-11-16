"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

const GLYPHS = "ABCDEF0123456789#$%&@<>/\\|=+*";

/**
 * Global micro-interactions, all opt-in by attribute/class, all off under reduced motion:
 *  - [data-scramble]: text decodes from random glyphs when it scrolls into view and on hover
 *  - .spot: a cursor-following spotlight (sets --mx/--my)
 *  - scroll progress line at the top
 */
export function Fx() {
  const pathname = usePathname();
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cleanups: (() => void)[] = [];

    // scroll progress
    const bar = document.querySelector<HTMLElement>(".scroll-progress");
    const onScroll = () => {
      if (!bar) return;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.transform = `scaleX(${max > 0 ? window.scrollY / max : 0})`;
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    cleanups.push(() => window.removeEventListener("scroll", onScroll));

    // spotlight
    const onMove = (e: PointerEvent) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(".spot");
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${e.clientX - r.left}px`);
      el.style.setProperty("--my", `${e.clientY - r.top}px`);
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    cleanups.push(() => document.removeEventListener("pointermove", onMove));

    if (!reduced) {
      // scramble / decode
      const scramble = (el: HTMLElement) => {
        const final = el.dataset.final ?? el.textContent ?? "";
        el.dataset.final = final;
        if (el.dataset.running) return;
        el.dataset.running = "1";
        let frame = 0;
        const total = Math.min(28, 10 + final.length);
        const id = setInterval(() => {
          frame++;
          const done = Math.floor((frame / total) * final.length);
          el.textContent = final
            .split("")
            .map((ch, i) => (i < done || ch === " " ? ch : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]))
            .join("");
          if (frame >= total) {
            clearInterval(id);
            el.textContent = final;
            delete el.dataset.running;
          }
        }, 32);
      };
      const els = Array.from(document.querySelectorAll<HTMLElement>("[data-scramble]"));
      const io = new IntersectionObserver(
        (entries) =>
          entries.forEach((e) => {
            if (e.isIntersecting) {
              scramble(e.target as HTMLElement);
              io.unobserve(e.target);
            }
          }),
        { threshold: 0.6 },
      );
      els.forEach((el) => {
        io.observe(el);
        const host = el.closest<HTMLElement>("a,button,.eyebrow") ?? el;
        const h = () => scramble(el);
        host.addEventListener("pointerenter", h);
        cleanups.push(() => host.removeEventListener("pointerenter", h));
      });
      cleanups.push(() => io.disconnect());
    }

    return () => cleanups.forEach((c) => c());
  }, [pathname]);

  return <div className="scroll-progress" aria-hidden="true" />;
}
