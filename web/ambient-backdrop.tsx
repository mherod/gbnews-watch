import { useEffect, useRef } from "react";
import * as THREE from "three";

interface BackdropProps {
  moodTone?: "heated" | "grumbly" | "mixed" | "warm" | "buzzing";
}

/**
 * An ambient 3D Westminster particle mist and luminous constellation backdrop
 * built with Three.js. Renders subtle floating motes and golden embers that
 * shift gently with the room's mood and user pointer motion.
 */
export function AmbientBackdrop({ moodTone = "warm" }: BackdropProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const moodRef = useRef(moodTone);
  moodRef.current = moodTone;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Check if user prefers reduced motion
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 1000);
    camera.position.z = 400;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.domElement.style.position = "absolute";
    renderer.domElement.style.inset = "0";
    renderer.domElement.style.pointerEvents = "none";
    container.appendChild(renderer.domElement);

    // Particle field: 240 ambient floating particles (Westminster mist & gold sparks)
    const particleCount = 200;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    const speeds = new Float32Array(particleCount);

    const baseColor = new THREE.Color("#d97706"); // Westminster Gold
    const warmColor = new THREE.Color("#22c55e"); // British Racing Green
    const heatedColor = new THREE.Color("#ef4444"); // Routemaster Red
    const blueColor = new THREE.Color("#3b82f6"); // Piccadilly Blue

    for (let i = 0; i < particleCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 800;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 800;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 400;

      // Color variation
      const c = Math.random() > 0.5 ? baseColor : Math.random() > 0.5 ? blueColor : warmColor;
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;

      speeds[i] = 0.2 + Math.random() * 0.4;
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    // Particle sprite using canvas circle
    const spriteCanvas = document.createElement("canvas");
    spriteCanvas.width = 32;
    spriteCanvas.height = 32;
    const sCtx = spriteCanvas.getContext("2d")!;
    const grad = sCtx.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, "rgba(255, 255, 255, 1)");
    grad.addColorStop(0.3, "rgba(255, 255, 255, 0.7)");
    grad.addColorStop(0.8, "rgba(255, 255, 255, 0.15)");
    grad.addColorStop(1, "rgba(255, 255, 255, 0)");
    sCtx.fillStyle = grad;
    sCtx.beginPath();
    sCtx.arc(16, 16, 16, 0, Math.PI * 2);
    sCtx.fill();

    const texture = new THREE.CanvasTexture(spriteCanvas);

    const material = new THREE.PointsMaterial({
      size: 14,
      map: texture,
      vertexColors: true,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const particles = new THREE.Points(geometry, material);
    scene.add(particles);

    // Mouse parallax tracking
    let targetMouseX = 0;
    let targetMouseY = 0;
    let currentMouseX = 0;
    let currentMouseY = 0;

    const onPointerMove = (e: MouseEvent) => {
      targetMouseX = (e.clientX - window.innerWidth / 2) * 0.05;
      targetMouseY = (e.clientY - window.innerHeight / 2) * 0.05;
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });

    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener("resize", onResize);

    let animId = 0;
    let isVisible = true;

    const onVisibilityChange = () => {
      isVisible = !document.hidden;
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    const animate = () => {
      animId = requestAnimationFrame(animate);
      if (!isVisible) return;

      currentMouseX += (targetMouseX - currentMouseX) * 0.05;
      currentMouseY += (targetMouseY - currentMouseY) * 0.05;

      camera.position.x = currentMouseX;
      camera.position.y = -currentMouseY;
      camera.lookAt(scene.position);

      // Rotate particle cloud gently
      particles.rotation.y += 0.0004;
      particles.rotation.x += 0.0002;

      // Update positions
      const posAttr = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
      if (posAttr) {
        const pos = posAttr.array as Float32Array;
        for (let i = 0; i < particleCount; i++) {
          const speed = speeds[i] ?? 0.3;
          const currY = pos[i * 3 + 1] ?? 0;
          pos[i * 3 + 1] = currY + speed * 0.4;
          if (pos[i * 3 + 1]! > 400) {
            pos[i * 3 + 1] = -400;
            pos[i * 3] = (Math.random() - 0.5) * 800;
          }
        }
        posAttr.needsUpdate = true;
      }

      // React to mood tone
      const currentMood = moodRef.current;
      const targetC = currentMood === "heated" || currentMood === "grumbly" ? heatedColor : currentMood === "buzzing" || currentMood === "warm" ? warmColor : baseColor;
      const colAttr = geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
      if (colAttr) {
        const colArr = colAttr.array as Float32Array;
        for (let i = 0; i < particleCount; i += 4) {
          const r = colArr[i * 3] ?? 0;
          const g = colArr[i * 3 + 1] ?? 0;
          const b = colArr[i * 3 + 2] ?? 0;
          colArr[i * 3] = r + (targetC.r - r) * 0.02;
          colArr[i * 3 + 1] = g + (targetC.g - g) * 0.02;
          colArr[i * 3 + 2] = b + (targetC.b - b) * 0.02;
        }
        colAttr.needsUpdate = true;
      }

      renderer.render(scene, camera);
    };

    animate();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      geometry.dispose();
      material.dispose();
      texture.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 0,
        overflow: "hidden",
      }}
    />
  );
}
