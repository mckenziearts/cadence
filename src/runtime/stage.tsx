// 3D stage and camera. Both render nothing but a plain layer at rest, so cuts stay pixel-identical.
import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import { useCanvas } from './scene';
import type { Point } from './types';

// Springs never land exactly, so values this close to rest count as rest: 0.001 deg or px, and a scale delta of
// 1e-5 (0.01 px at the edge of a 1920 px canvas; 1e-3 would snap by a visible pixel).
const moving = (v: number) => Math.abs(v) >= 1e-3;
const scaling = (s: number) => Math.abs(s - 1) >= 1e-5;

export interface Stage3DPose {
  /** Distance of the viewer in px (default 1800). Smaller = stronger perspective. */
  perspective?: number;
  /** Pivot of the rotation and vanishing point, canvas px (default: canvas center). */
  focus?: Point;
  /** Degrees. rotateX > 0 tilts the top away from the viewer. Applied Z, then Y, then X. */
  rotateX?: number;
  rotateY?: number;
  rotateZ?: number;
  /** Translation after rotation, px (z > 0 comes toward the viewer). */
  x?: number;
  y?: number;
  z?: number;
  scale?: number;
}

export interface Stage3DProps extends Stage3DPose {
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

const Stage3DContext = createContext(false);

function isFlat(p: Stage3DPose): boolean {
  const { rotateX = 0, rotateY = 0, rotateZ = 0, x = 0, y = 0, z = 0, scale = 1 } = p;
  return ![rotateX, rotateY, rotateZ, x, y, z].some(moving) && !scaling(scale);
}

/**
 * Full-canvas perspective container: children are positioned in canvas px and can be lifted with <Layer3D z>.
 * Flat at rest: when every pose value is 0 (scale 1) it renders a plain layer, no perspective or preserve-3d,
 * so the frame is identical to the same UI rendered flat in the neighbouring scene.
 */
export function Stage3D({ children, style, className, ...pose }: Stage3DProps) {
  const { width, height } = useCanvas();
  if (isFlat(pose)) {
    return (
      <div className={className} style={{ position: 'absolute', inset: 0, ...style }}>
        <Stage3DContext.Provider value={false}>{children}</Stage3DContext.Provider>
      </div>
    );
  }
  const { perspective = 1800, focus = { x: width / 2, y: height / 2 } } = pose;
  const { rotateX = 0, rotateY = 0, rotateZ = 0, x = 0, y = 0, z = 0, scale = 1 } = pose;
  const origin = `${focus.x}px ${focus.y}px`;
  return (
    <div className={className} style={{ position: 'absolute', inset: 0, perspective, perspectiveOrigin: origin, ...style }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          transformStyle: 'preserve-3d',
          transformOrigin: origin,
          transform: `translate3d(${x}px, ${y}px, ${z}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) rotateZ(${rotateZ}deg) scale3d(${scale}, ${scale}, ${scale})`,
        }}
      >
        <Stage3DContext.Provider value={true}>{children}</Stage3DContext.Provider>
      </div>
    </div>
  );
}

/**
 * A full-canvas layer lifted `z` px toward the viewer inside a Stage3D (exploded views). It is flat when the stage is
 * flat or z is 0. Put it directly in Stage3D, or in wrappers that set transformStyle: 'preserve-3d'.
 */
export function Layer3D({
  z = 0,
  children,
  style,
  className,
}: {
  z?: number;
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  const in3D = useContext(Stage3DContext);
  return (
    <div
      className={className}
      style={{
        position: 'absolute',
        inset: 0,
        ...(in3D ? { transformStyle: 'preserve-3d' as const } : null),
        transform: in3D && moving(z) ? `translateZ(${z}px)` : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Where a point of a Stage3D layer lands on the canvas: same math as the CSS, so callouts can anchor to 3D parts.
 * `canvas` is only used for the default focus (the canvas center).
 *   const p = project3D({ x: 700, y: 450, z: 120 * explode }, POSE, { width, height })   // POSE = the <Stage3D> props
 */
export function project3D(
  point: { x: number; y: number; z?: number },
  pose: Stage3DPose,
  canvas: { width: number; height: number },
): Point {
  const { perspective = 1800, focus = { x: canvas.width / 2, y: canvas.height / 2 } } = pose;
  const { rotateX = 0, rotateY = 0, rotateZ = 0, x = 0, y = 0, z = 0, scale = 1 } = pose;
  const rad = Math.PI / 180;
  let px = (point.x - focus.x) * scale;
  let py = (point.y - focus.y) * scale;
  let pz = (point.z ?? 0) * scale;
  const [sz, cz] = [Math.sin(rotateZ * rad), Math.cos(rotateZ * rad)];
  [px, py] = [px * cz - py * sz, px * sz + py * cz];
  const [sy, cy] = [Math.sin(rotateY * rad), Math.cos(rotateY * rad)];
  [px, pz] = [px * cy + pz * sy, -px * sy + pz * cy];
  const [sx, cx] = [Math.sin(rotateX * rad), Math.cos(rotateX * rad)];
  [py, pz] = [py * cx - pz * sx, py * sx + pz * cx];
  px += x;
  py += y;
  pz += z;
  const k = perspective / (perspective - pz);
  return { x: focus.x + px * k, y: focus.y + py * k };
}

const CameraContext = createContext(1);

/** Effective zoom of the enclosing <Camera>s (1 outside any camera). Divide stroke widths by it to keep them constant. */
export function useCameraZoom(): number {
  return useContext(CameraContext);
}

export interface CameraProps {
  /** Content point (canvas px) shown at the center of the frame. Default: the canvas center. */
  x?: number;
  y?: number;
  /** 1 = no zoom, 4 = four times closer. */
  zoom?: number;
  /** Degrees, around the center of the frame. */
  rotate?: number;
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

/** @internal Zero-size box at content point (x, y); its children keep their screen size under Camera zoom. */
export function Pin({ x, y, opacity, children }: { x: number; y: number; opacity?: number; children?: ReactNode }) {
  const zoom = useCameraZoom();
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: 0,
        height: 0,
        transformOrigin: '0 0',
        transform: zoom === 1 ? undefined : `scale(${1 / zoom})`,
        opacity,
        pointerEvents: 'none',
      }}
    >
      {children}
    </div>
  );
}

/** @internal Full-canvas SVG layer in content coordinates (drawing may overflow the canvas). */
export function Overlay({ children }: { children?: ReactNode }) {
  const { width, height } = useCanvas();
  return (
    <svg
      width={width}
      height={height}
      style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}
    >
      {children}
    </svg>
  );
}

/**
 * Zoom, pan and rotate everything inside, looking at content point (x, y). Kit annotations inside a camera keep their
 * screen size (strokes, dots, tags divide by the zoom). At rest (x, y = canvas center, zoom 1, rotate 0) it adds no
 * transform at all.
 */
export function Camera({ x, y, zoom = 1, rotate = 0, children, style, className }: CameraProps) {
  const { width, height } = useCanvas();
  const parentZoom = useContext(CameraContext);
  const cx = x ?? width / 2;
  const cy = y ?? height / 2;
  const atRest = ![cx - width / 2, cy - height / 2, rotate].some(moving) && !scaling(zoom);
  return (
    <CameraContext.Provider value={parentZoom * (atRest ? 1 : zoom)}>
      <div
        className={className}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width,
          height,
          transformOrigin: '0 0',
          transform: atRest
            ? undefined
            : `translate(${width / 2}px, ${height / 2}px) rotate(${rotate}deg) scale(${zoom}) translate(${-cx}px, ${-cy}px)`,
          ...style,
        }}
      >
        {children}
      </div>
    </CameraContext.Provider>
  );
}
