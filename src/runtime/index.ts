// The `cadence` module every scene imports. Reference for the agent: ./API.md (keep both in sync).
export { ease, bezier, type Easing } from './easing';
export {
  clamp,
  mix,
  remap,
  interpolate,
  progress,
  keyframes,
  stagger,
  staggerFrom,
  loop,
  pingpong,
  spring,
  springs,
  springDuration,
  type InterpolateOptions,
  type SpringOptions,
} from './animate';
export { parseColor, toHex, mixColor, interpolateColor, withAlpha, type RGBA } from './color';
export { random, randomRange, noise, noise2 } from './random';
export { createMusic, type CreateMusicInput, type Music, type MusicGrid, type MusicSection } from './music';
export {
  Fill,
  SceneContext,
  useScene,
  BrandContext,
  useBrand,
  useFormat,
  asset,
  setAssetBase,
  type FormatInfo,
  type FormatValues,
} from './scene';
export { SAFE_AREAS, type SafeArea } from '../shared/types';
export {
  SplitText,
  typed,
  measureText,
  TypeOn,
  SwapWords,
  Counter,
  type TextStyle,
  type TypeOnProps,
  type SwapWordsProps,
  type CounterProps,
} from './text';
export {
  Stage3D,
  Layer3D,
  project3D,
  Camera,
  useCameraZoom,
  type Stage3DPose,
  type Stage3DProps,
  type CameraProps,
} from './stage';
export {
  rectPath,
  DrawPath,
  Glow,
  Tag,
  Callout,
  Dimension,
  RadiusArc,
  Guide,
  Highlight,
  type Anchor,
  type DrawPathProps,
  type GlowProps,
  type TagProps,
  type CalloutProps,
  type DimensionProps,
  type RadiusArcProps,
  type GuideProps,
  type HighlightProps,
} from './annotate';
export { Cursor, cursorAt, cursorPress, ClickRipple, type CursorKey, type CursorProps, type ClickRippleProps } from './pointer';
export {
  BrowserFrame,
  PhoneFrame,
  Grain,
  Vignette,
  type BrowserFrameProps,
  type PhoneFrameProps,
  type GrainProps,
  type VignetteProps,
} from './chrome';
export type { SceneProps, SceneInfo, Point, BrandKit, FormatId, Orientation } from './types';
