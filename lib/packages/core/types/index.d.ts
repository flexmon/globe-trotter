/**
 * Type declarations for the stable `@globe-trotter/core` public surface.
 * Advanced/internal exports are typed loosely in `./advanced.d.ts`.
 */

// ─── Shared value types ───

export type ProjectionMode = 'spherical' | 'mercator';
export type ClockSource = 'internal' | 'external' | 'live';

export interface ViewState {
  lat: number;
  lon: number;
  distance: number;
  /** degrees (0 on the Mercator camera) */
  heading: number;
  /** degrees (0 on the Mercator camera) */
  tilt: number;
}

export interface TimeInfo {
  epochSec: number;
  normalized: number;
  source: ClockSource;
  playing: boolean;
}

export interface TimeWindow {
  startEpochSec: number;
  endEpochSec: number;
}

export interface LayerState {
  name: string;
  visible: boolean;
  filter: string | null;
  style: object | null;
}

export interface EngineState {
  version: number;
  camera: ViewState;
  time: { epochSec: number; source: ClockSource };
  basemap: string | null;
  projection: ProjectionMode;
  layers: LayerState[];
}

export interface Capabilities {
  webgpu: boolean;
}

/** Which UI widgets to create; any omitted key defaults to visible. */
export interface UIWidgets {
  footer?: boolean;
  layers?: boolean;
  geocoder?: boolean;
  time?: boolean;
  legend?: boolean;
  charts?: boolean;
  chartToggle?: boolean;
  projection?: boolean;
  compass?: boolean;
  basemap?: boolean;
  dropZone?: boolean;
  loadingScreen?: boolean | Record<string, unknown>;
}

export interface EngineOptions {
  mapboxToken?: string | null;
  googleMapsApiKey?: string | null;
  basemapProvider?: 'mapbox' | 'google' | null;
  geocoderProvider?: 'mapbox' | 'google' | null;
  basemap?: string | null;
  antialias?: boolean;
  background?: [number, number, number, number];
  powerPreference?: 'high-performance' | 'low-power';
  maxDpr?: number;
  autoStart?: boolean;
  camera?: { center?: [number, number]; altitude?: number; tilt?: number; heading?: number };
  time?: {
    enabled?: boolean;
    autoplay?: boolean;
    speed?: number;
    startOffset?: string | number;
    loop?: boolean;
    window?: { start: string | number; end: string | number };
  };
  ui?: boolean;
  uiWidgets?: UIWidgets;
  uiContainer?: HTMLElement | null;
  onProgress?: ((message: string, percent: number) => void) | null;
  projectionMode?: ProjectionMode;
}

export interface LoadConfigResult {
  ok: boolean;
  layersLoaded: number;
  layersFailed: number;
  errors: string[];
}

// ─── Event catalog ───

export interface GlobeEventMap {
  ready: {};
  unsupported: { reason: string };
  error: { error: Error };
  viewChanged: ViewState;
  timeChanged: { epochSec: number; normalized: number };
  selection: {
    layer: string | null;
    feature: Record<string, unknown> | null;
    featureIndex?: number;
    lngLat: [number, number] | null;
  };
  layerLoad: { name: string; status: 'loading' | 'ready' | 'error'; error?: Error };
  frame: { time: number; normalizedTime: number; fps: number; drawCalls: number; features: number };
  layerAdded: { name: string; type?: string };
  layerRemoved: { name: string };
}

export type GlobeEvent = keyof GlobeEventMap;

// ─── Errors ───

export class WebGPURequiredError extends Error {}

// ─── Engine ───

export class GlobeTrotterEngine {
  constructor(canvas: HTMLCanvasElement, options?: EngineOptions);

  readonly canvas: HTMLCanvasElement;
  capabilities: Capabilities;
  projectionMode: ProjectionMode;

  // Lifecycle
  ready(): Promise<void>;
  readonly isReady: boolean;
  readonly isDestroyed: boolean;
  start(): void;
  stop(): void;
  destroy(): void;
  requestRender(): void;
  resize(): void;

  // Events (on() returns an unsubscribe function)
  on<E extends GlobeEvent>(event: E, callback: (payload: GlobeEventMap[E]) => void): () => void;
  on(event: string, callback: (payload: any) => void): () => void;
  off(event: string, callback: (payload: any) => void): void;

  // Camera / view
  setView(view: Partial<ViewState>): void;
  getView(): ViewState;
  flyTo(lat: number, lon: number, distance?: number): void;

  // Projection
  setProjectionMode(mode: ProjectionMode): boolean;
  getProjectionMode(): ProjectionMode;

  // Time
  play(): void;
  pause(): void;
  togglePlay(): boolean;
  setSpeed(speed: number): void;
  getSpeedLabel(): string;
  scrubTo(normalized: number): void;
  getNormalizedTime(): number;
  getFormattedTime(): string;
  isPlaying(): boolean;
  getCurrentEpoch(): number;
  setTime(epochSec: number): void;
  setTimeWindow(startEpochSec: number, endEpochSec: number): void;
  clearTimeWindow(): void;
  getTimeWindow(): TimeWindow | null;
  setClockSource(source: ClockSource): void;
  pushEpoch(epochSec: number): void;
  getTime(): TimeInfo;

  // Basemap
  setBasemap(style: string): void;
  getBasemap(): string | null;

  // Filters
  setFilter(name: string, queryStr: string): void;
  clearFilter(name: string): void;
  getFilter(name: string): string | null;

  // Layers
  loadConfig(config: Record<string, unknown>): Promise<LoadConfigResult>;
  addGeoJSONLayer(name: string, geojson: object, options?: Record<string, unknown>): unknown;
  removeLayer(name: string): void;
  setLayerVisibility(name: string, visible: boolean): void;
  toggleLayerVisibility(name: string): void;
  setLayerStyle(name: string, styleSpec: object): void;
  getLayerInfo(): Array<Record<string, unknown>>;
  getLayerNames(): string[];

  // UI visibility
  setWidgetVisible(name: string, visible: boolean): boolean;
  getWidgetVisibility(): Record<string, boolean>;

  // State round-trip
  getState(): EngineState;
  applyState(state: Partial<EngineState>): Promise<void>;

  // Charts
  addChart(name: string, config: Record<string, unknown>): void;
  removeChart(name: string): void;
  setChartVisibility(name: string, visible: boolean): void;
}

// ─── Styling ───

export class StyleEngine {
  static ramp(options: Record<string, unknown>): object;
  static categorical(options: Record<string, unknown>): object;
  static compile(device: unknown, spec: object, dictionary?: unknown): object;
}

// ─── Query filter operators (value type) ───

export const FilterOp: Readonly<Record<string, number>>;

// ─── Geo value helpers / constants ───

export function altitudeToZoom(altitudeKm: number, lat?: number): number;
export function zoomToAltitude(zoom: number, lat?: number): number;
export const EARTH_CIRC_KM: number;
export const EARTH_RADIUS_KM: number;
