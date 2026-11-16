"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import type { SceneEvent } from "./LeashScene";
import { useFeed } from "./useFeed";

const LeashScene = dynamic(() => import("./LeashScene").then((m) => m.LeashScene), { ssr: false });

/** Full-bleed 3D scene plus a HUD of live readouts. Scene counters are the animation; chain numbers are real. */
export function HeroVisual() {
  const [paid, setPaid] = useState(0);
  const [blocked, setBlocked] = useState(0);
  const [flash, setFlash] = useState<"paid" | "blocked" | null>(null);
  const { data } = useFeed();
  const onEvent = useCallback((e: SceneEvent) => {
    if (e.kind === "paid") setPaid((n) => n + 1);
    else setBlocked((n) => n + 1);
    setFlash(e.kind);
  }, []);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 700);
    return () => clearTimeout(t);
  }, [flash]);

  return (
    <div className="hero-visual" aria-hidden="true">
      <LeashScene onEvent={onEvent} />
      <div className="hud">
        <span className="hud-corner tl" />
        <span className="hud-corner tr" />
        <span className="hud-corner bl" />
        <span className="hud-corner br" />
        <div className="hud-top">
          <span className="hud-tag">
            <i className="blip" /> LEASH://SESSION-0x1364
          </span>
          <span className="hud-dim">AEVUM 44005 · BLK {data ? data.head.toLocaleString("en-US") : "———"}</span>
        </div>
        <div className="hud-readouts">
          <div className={`hud-cell${flash === "paid" ? " ping" : ""}`}>
            <span className="hud-k">settled</span>
            <span className="hud-v cyan num">{String(paid).padStart(3, "0")}</span>
          </div>
          <div className={`hud-cell${flash === "blocked" ? " ping bad" : ""}`}>
            <span className="hud-k">blocked at leash</span>
            <span className="hud-v red num">{String(blocked).padStart(3, "0")}</span>
          </div>
          <div className="hud-cell">
            <span className="hud-k">integrity</span>
            <span className="hud-v num">100%</span>
          </div>
        </div>
        <div className="hud-legend">
          <span>
            <i className="lg pink" /> payment inside the leash
          </span>
          <span>
            <i className="lg red" /> injected payment · reverted
          </span>
        </div>
      </div>
    </div>
  );
}
