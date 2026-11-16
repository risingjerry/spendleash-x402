"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

/**
 * Hero scene. The agent is a breathing particle core. The leash is a geodesic cage around it.
 * Merchants orbit inside the cage and receive pink payment pulses; an attacker sits outside,
 * its red pulse hits the cage, the cage ripples red at the impact point and throws sparks.
 * Neon grid floor, bloom, a touch of chromatic aberration and scanlines.
 */

const PINK = new THREE.Color("#ff4fd8");
const ORCHID = new THREE.Color("#e6a7f1");
const CYAN = new THREE.Color("#3ff3ff");
const VIOLET = new THREE.Color("#7c5cff");
const RED = new THREE.Color("#ff2d55");
const CAGE_R = 2.25;

export type SceneEvent = { kind: "paid" } | { kind: "blocked" };

export function LeashScene({ onEvent }: { onEvent?: (e: SceneEvent) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef(onEvent);
  cb.current = onEvent;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    } catch {
      el.dataset.fallback = "1";
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x000000, 0.055);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 1.1, 9.2);

    const world = new THREE.Group();
    scene.add(world);

    // ── neon grid floor ─────────────────────────────────────────────
    const gridMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: { value: 0 }, uA: { value: VIOLET }, uB: { value: CYAN } },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: `
        varying vec3 vP; uniform float uTime; uniform vec3 uA; uniform vec3 uB;
        float line(float x, float w){ float f = abs(fract(x - .5) - .5) / fwidth(x); return 1. - min(f / w, 1.); }
        void main(){
          vec2 p = vP.xy; p.y += uTime * .35;
          float g = max(line(p.x, 1.), line(p.y, 1.));
          float d = length(vP.xy) / 14.;
          float fade = smoothstep(1., .05, d);
          vec3 c = mix(uB, uA, smoothstep(0., .8, d));
          gl_FragColor = vec4(c, g * fade * .55);
        }`,
      extensions: { derivatives: true } as never,
    });
    const grid = new THREE.Mesh(new THREE.PlaneGeometry(40, 40, 1, 1), gridMat);
    grid.rotation.x = -Math.PI / 2;
    grid.position.y = -2.6;
    scene.add(grid);

    // ── star dust ───────────────────────────────────────────────────
    {
      const n = 900;
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const r = 6 + Math.random() * 18;
        const t = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        pos.set([r * Math.sin(ph) * Math.cos(t), r * Math.cos(ph) * 0.6 + 1, r * Math.sin(ph) * Math.sin(t) - 6], i * 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8a7dff, size: 0.025, transparent: true, opacity: 0.55, depthWrite: false })));
    }

    // ── the agent core: breathing particle sphere ───────────────────
    const coreMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uPulse: { value: 0 }, uA: { value: PINK }, uB: { value: CYAN }, uPx: { value: renderer.getPixelRatio() } },
      vertexShader: `
        uniform float uTime; uniform float uPulse; uniform float uPx; attribute float aSeed; varying float vMix; varying float vA;
        // cheap 3D noise
        float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
        float n3(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
          return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),
                     mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z); }
        void main(){
          vec3 p = position;
          float n = n3(p * 2.2 + uTime * .35);
          float r = .78 + n * .22 + sin(uTime * 1.6 + aSeed * 6.28) * .02 + uPulse * .12;
          p = normalize(p) * r;
          vMix = n; vA = .35 + .65 * n;
          vec4 mv = modelViewMatrix * vec4(p, 1.);
          gl_PointSize = (1.3 + n * 1.9) * uPx * (6. / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uA; uniform vec3 uB; varying float vMix; varying float vA;
        void main(){ float d = length(gl_PointCoord - .5); if (d > .5) discard;
          float s = smoothstep(.5, 0., d); gl_FragColor = vec4(mix(uB, uA, vMix) * (.5 + s * .55), s * vA * .75); }`,
    });
    {
      const n = 5200;
      const pos = new Float32Array(n * 3);
      const seed = new Float32Array(n);
      const golden = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < n; i++) {
        const y = 1 - (i / (n - 1)) * 2;
        const rr = Math.sqrt(1 - y * y);
        const t = golden * i;
        pos.set([Math.cos(t) * rr, y, Math.sin(t) * rr], i * 3);
        seed[i] = Math.random();
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
      world.add(new THREE.Points(g, coreMat));
    }
    // inner glow
    const glowTex = (() => {
      const c = document.createElement("canvas");
      c.width = c.height = 128;
      const x = c.getContext("2d")!;
      const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, "rgba(255,255,255,1)");
      gr.addColorStop(0.25, "rgba(255,120,230,.55)");
      gr.addColorStop(1, "rgba(120,80,255,0)");
      x.fillStyle = gr;
      x.fillRect(0, 0, 128, 128);
      return new THREE.CanvasTexture(c);
    })();
    const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.55 }));
    coreGlow.scale.setScalar(2.1);
    world.add(coreGlow);

    // ── the leash: geodesic cage with an impact ripple ──────────────
    const cageGeo = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(CAGE_R, 2));
    const cageMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uHit: { value: new THREE.Vector3(9, 9, 9) },
        uHitT: { value: -10 },
        uA: { value: VIOLET },
        uB: { value: CYAN },
        uRed: { value: RED },
      },
      vertexShader: `varying vec3 vW; varying vec3 vL; void main(){ vL = position; vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `
        uniform float uTime; uniform vec3 uHit; uniform float uHitT; uniform vec3 uA; uniform vec3 uB; uniform vec3 uRed;
        varying vec3 vW; varying vec3 vL;
        void main(){
          float band = .5 + .5 * sin(vL.y * 5. - uTime * 1.8);
          vec3 c = mix(uA, uB, band * .55);
          float a = .26 + band * .22;
          float age = uTime - uHitT;
          float dist = distance(vW, uHit);
          float ring = exp(-pow((dist - age * 2.6) * 3.2, 2.)) * exp(-age * 1.4);
          float core = exp(-dist * 2.4) * exp(-age * 3.);
          float hit = clamp(ring + core, 0., 1.6);
          c = mix(c, uRed * 1.8, clamp(hit, 0., 1.));
          gl_FragColor = vec4(c, a + hit);
        }`,
    });
    const cage = new THREE.LineSegments(cageGeo, cageMat);
    world.add(cage);
    // vertex nodes on the cage
    {
      const ico = new THREE.IcosahedronGeometry(CAGE_R, 1);
      const p = ico.getAttribute("position");
      const seen = new Set<string>();
      const pts: number[] = [];
      for (let i = 0; i < p.count; i++) {
        const k = `${p.getX(i).toFixed(2)},${p.getY(i).toFixed(2)},${p.getZ(i).toFixed(2)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        pts.push(p.getX(i), p.getY(i), p.getZ(i));
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      cage.add(new THREE.Points(g, new THREE.PointsMaterial({ color: CYAN, size: 0.05, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })));
    }
    // equator HUD ring
    const hudRing = new THREE.Mesh(
      new THREE.RingGeometry(CAGE_R + 0.32, CAGE_R + 0.335, 160),
      new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.35, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    hudRing.rotation.x = Math.PI / 2;
    const rings = new THREE.Group();
    rings.rotation.x = -0.38;
    rings.rotation.z = 0.12;
    rings.add(hudRing);
    world.add(rings);
    const tickRing = (() => {
      const pts: number[] = [];
      for (let i = 0; i < 120; i++) {
        const a = (i / 120) * Math.PI * 2;
        const r0 = CAGE_R + 0.4;
        const r1 = r0 + (i % 10 === 0 ? 0.16 : 0.06);
        pts.push(Math.cos(a) * r0, 0, Math.sin(a) * r0, Math.cos(a) * r1, 0, Math.sin(a) * r1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: ORCHID, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending }));
    })();
    rings.add(tickRing);

    // ── merchants (inside) and attacker (outside) ───────────────────
    const nodeGeo = new THREE.OctahedronGeometry(0.11, 0);
    const merchants = [0, 1, 2].map((i) => {
      const m = new THREE.Mesh(nodeGeo, new THREE.MeshBasicMaterial({ color: CYAN }));
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: CYAN, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.35, depthWrite: false }));
      halo.scale.setScalar(0.7);
      m.add(halo);
      world.add(m);
      return { mesh: m, halo, phase: (i / 3) * Math.PI * 2, tilt: (i - 1) * 0.55, flash: 0 };
    });
    const attacker = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), new THREE.MeshBasicMaterial({ color: RED, wireframe: true }));
    const attackerHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: RED, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.45, depthWrite: false }));
    attackerHalo.scale.setScalar(0.9);
    attacker.add(attackerHalo);
    world.add(attacker);

    // ── payment pulses ──────────────────────────────────────────────
    type Pulse = { mesh: THREE.Sprite; trail: THREE.Line; curve: THREE.QuadraticBezierCurve3; t: number; dur: number; bad: boolean; target?: (typeof merchants)[number] };
    const pulses: Pulse[] = [];
    const TRAIL = 24;
    function spawn(bad: boolean) {
      const from = new THREE.Vector3(0, 0, 0);
      let to: THREE.Vector3;
      let target: Pulse["target"];
      if (bad) {
        to = attacker.position.clone().normalize().multiplyScalar(CAGE_R);
      } else {
        target = merchants[Math.floor(Math.random() * merchants.length)]!;
        to = target.mesh.position.clone();
      }
      const mid = from.clone().lerp(to, 0.5).add(new THREE.Vector3(0, 0.9 + Math.random() * 0.5, 0));
      const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
      const color = bad ? RED : PINK;
      const mesh = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
      mesh.scale.setScalar(0.32);
      const tg = new THREE.BufferGeometry();
      tg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3));
      const trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending }));
      world.add(mesh, trail);
      pulses.push({ mesh, trail, curve, t: 0, dur: bad ? 1.1 : 1.3, bad, target });
    }

    // sparks on impact
    const SPARKS = 90;
    const sparkPos = new Float32Array(SPARKS * 3);
    const sparkVel = new Float32Array(SPARKS * 3);
    const sparkGeo = new THREE.BufferGeometry();
    sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
    const sparkMat = new THREE.PointsMaterial({ color: RED, size: 0.06, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    world.add(new THREE.Points(sparkGeo, sparkMat));
    let sparkLife = 0;
    function burst(at: THREE.Vector3) {
      const n = at.clone().normalize();
      for (let i = 0; i < SPARKS; i++) {
        sparkPos.set([at.x, at.y, at.z], i * 3);
        const v = new THREE.Vector3().randomDirection().multiplyScalar(0.6 + Math.random() * 1.6).add(n.clone().multiplyScalar(-0.4 + Math.random() * 1.6));
        sparkVel.set([v.x, v.y, v.z], i * 3);
      }
      sparkGeo.attributes.position!.needsUpdate = true;
      sparkLife = 1;
    }

    // ── post: bloom, chromatic aberration + scanlines ───────────────
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.82, 0.5, 0.2);
    composer.addPass(bloom);
    const fx = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uShift: { value: 0.0016 }, uGlitch: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform float uTime; uniform float uShift; uniform float uGlitch; uniform vec2 uRes; varying vec2 vUv;
        float r(float x){ return fract(sin(x * 91.7) * 4375.5); }
        void main(){
          vec2 uv = vUv;
          float row = floor(uv.y * 48.);
          uv.x += uGlitch * (r(row + floor(uTime * 24.)) - .5) * .045 * step(.82, r(row * 3.1 + floor(uTime * 12.)));
          vec2 dir = (uv - .5);
          float s = uShift + uGlitch * .01;
          vec4 c = texture2D(tDiffuse, uv);
          c.r = texture2D(tDiffuse, uv + dir * s * 2.).r;
          c.b = texture2D(tDiffuse, uv - dir * s * 2.).b;
          float scan = .94 + .06 * sin(vUv.y * uRes.y * 1.6);
          c.rgb *= scan;
          float v = smoothstep(1.15, .35, length(dir));
          c.rgb *= v;
          gl_FragColor = c;
        }`,
    });
    composer.addPass(fx);
    composer.addPass(new OutputPass());

    // ── sizing / interaction ────────────────────────────────────────
    let w = 1;
    let h = 1;
    function resize() {
      w = el!.clientWidth;
      h = el!.clientHeight;
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      bloom.resolution.set(w, h);
      (fx.uniforms.uRes!.value as THREE.Vector2).set(w, h);
      camera.aspect = w / h;
      // keep the cage on the right on wide screens, centered on narrow ones
      const wide = w > 980;
      camera.setViewOffset(w, h, wide ? -w * 0.2 : 0, wide ? 0 : -h * 0.04, w, h);
      camera.position.z = wide ? 9.2 : 10.8;
      camera.updateProjectionMatrix();
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    const onMove = (e: PointerEvent) => {
      mouse.tx = (e.clientX / window.innerWidth - 0.5) * 2;
      mouse.ty = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = Boolean(e?.isIntersecting)), { threshold: 0 });
    io.observe(el);

    // ── loop ────────────────────────────────────────────────────────
    const clock = new THREE.Clock();
    let next = 0.8;
    let cycle = 0;
    let glitch = 0;
    let corePulse = 0;
    let raf = 0;
    const tmp = new THREE.Vector3();

    function frame() {
      raf = requestAnimationFrame(frame);
      if (!visible) {
        clock.getDelta();
        return;
      }
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;

      mouse.x += (mouse.tx - mouse.x) * 0.04;
      mouse.y += (mouse.ty - mouse.y) * 0.04;
      world.rotation.y = t * 0.12 + mouse.x * 0.35;
      world.rotation.x = -0.12 + mouse.y * 0.12;
      camera.position.y = 1.1 - mouse.y * 0.35;
      camera.lookAt(0, 0.15, 0);
      cage.rotation.y = -t * 0.05;
      cage.rotation.z = Math.sin(t * 0.2) * 0.06;
      tickRing.rotation.y = -t * 0.3;

      merchants.forEach((m, i) => {
        const a = m.phase + t * 0.32;
        tmp.set(Math.cos(a) * 1.45, Math.sin(a * 0.7 + i) * 0.45 + m.tilt * 0.4, Math.sin(a) * 1.45);
        m.mesh.position.copy(tmp);
        m.mesh.rotation.x = t * 1.2;
        m.mesh.rotation.y = t * 0.9;
        m.flash = Math.max(0, m.flash - dt * 1.8);
        m.halo.material.opacity = 0.3 + m.flash * 0.9;
        m.mesh.scale.setScalar(1 + m.flash * 0.9);
      });
      const aa = t * 0.07 + 0.6;
      attacker.position.set(Math.cos(aa) * 3.25, 0.55 + Math.sin(t * 0.9) * 0.18, Math.sin(aa) * 3.25);
      attacker.rotation.x = t * 1.6;
      attacker.rotation.y = t * 1.1;

      // schedule: paid, paid, paid, injected
      if (!reduced && t > next) {
        const bad = cycle % 4 === 3;
        spawn(bad);
        cycle++;
        next = t + (bad ? 1.9 : 0.95);
      }

      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i]!;
        p.t += dt / p.dur;
        const k = Math.min(p.t, 1);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        // merchants move; keep the end point on them
        if (p.target) p.curve.v2.copy(p.target.mesh.position);
        p.curve.getPoint(e, p.mesh.position);
        const arr = p.trail.geometry.attributes.position!.array as Float32Array;
        for (let j = 0; j < TRAIL; j++) {
          const q = p.curve.getPoint(Math.max(0, e - (j / TRAIL) * 0.35), tmp);
          arr.set([q.x, q.y, q.z], j * 3);
        }
        p.trail.geometry.attributes.position!.needsUpdate = true;
        if (p.t >= 1) {
          if (p.bad) {
            const hit = p.curve.v2.clone().applyMatrix4(world.matrixWorld);
            (cageMat.uniforms.uHit!.value as THREE.Vector3).copy(hit);
            cageMat.uniforms.uHitT!.value = t;
            burst(p.curve.v2.clone());
            glitch = 1;
            cb.current?.({ kind: "blocked" });
          } else {
            if (p.target) p.target.flash = 1;
            corePulse = 1;
            cb.current?.({ kind: "paid" });
          }
          world.remove(p.mesh, p.trail);
          p.mesh.material.dispose();
          p.trail.geometry.dispose();
          (p.trail.material as THREE.Material).dispose();
          pulses.splice(i, 1);
        }
      }

      if (sparkLife > 0) {
        sparkLife = Math.max(0, sparkLife - dt * 0.9);
        for (let i = 0; i < SPARKS; i++) {
          sparkPos[i * 3] += sparkVel[i * 3]! * dt;
          sparkPos[i * 3 + 1] += sparkVel[i * 3 + 1]! * dt - dt * dt * 4;
          sparkPos[i * 3 + 2] += sparkVel[i * 3 + 2]! * dt;
          sparkVel[i * 3]! *= 0.97;
          sparkVel[i * 3 + 1]! *= 0.97;
          sparkVel[i * 3 + 2]! *= 0.97;
        }
        sparkGeo.attributes.position!.needsUpdate = true;
        sparkMat.opacity = sparkLife;
      }

      corePulse = Math.max(0, corePulse - dt * 2.2);
      glitch = Math.max(0, glitch - dt * 2.8);
      coreMat.uniforms.uTime!.value = t;
      coreMat.uniforms.uPulse!.value = corePulse;
      coreGlow.material.opacity = 0.18 + corePulse * 0.35 + Math.sin(t * 1.6) * 0.04;
      cageMat.uniforms.uTime!.value = t;
      gridMat.uniforms.uTime!.value = t;
      fx.uniforms.uTime!.value = t;
      fx.uniforms.uGlitch!.value = glitch;
      composer.render();
    }

    if (reduced) {
      clock.getDelta();
      composer.render();
    } else {
      frame();
    }
    el.dataset.ready = "1";

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener("pointermove", onMove);
      composer.dispose();
      renderer.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
      });
      glowTex.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={host} className="scene" aria-hidden="true" />;
}
