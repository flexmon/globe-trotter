/**
 * Loose type declarations for `@globe-trotter/core/advanced`.
 *
 * These expose engine internals and are intentionally typed as `any` — the
 * advanced surface is not part of the stable contract and its shapes may change
 * between releases. Prefer the fully-typed primary entry (`@globe-trotter/core`).
 */

// Rendering
export const TileManager: any;
export const GlobeRenderer: any;
export const TileRenderer: any;
export const MercatorTileRenderer: any;

// Basemap providers
export const BasemapProvider: any;
export const MapboxProvider: any;
export const GoogleProvider: any;

// Styling compilers
export const compileRampData: any;
export const uploadRampTexture: any;
export const compileCategoricalData: any;
export const uploadCategoricalTexture: any;

// Layer management
export const LayerManager: any;
export const H3FlexShards: any;
export const DGFlexShards: any;
export const MFBShards: any;
export const GFBShards: any;
export const VirtualH3Loader: any;
export const StreamingGFBLoader: any;
export const LoaderRegistry: any;
export const GFBLineRenderer: any;
export const GFBPolygonRenderer: any;
export const getMeshFromCache: any;
export const putMeshInCache: any;
export const buildDenseEpochBuffer: any;
export const computeEpochWindow: any;
export const sliceEpoch: any;
export const defaultH3StyleSpec: any;

// Decoders
export const decodeH3Flex: any;
export const decodeH3Mesh: any;
export const decodeDGFlex: any;
export const decodeDGFMesh: any;
export const decodeGFB: any;
export const decodeMFB: any;
export const MFBDataSource: any;

// GeoJSON loaders
export const parseGeoJSON: any;
export const geojsonToFeatures: any;
export const splitFeatureCollectionByGeometry: any;

// Picking
export const PickController: any;
export const SpatialIndex: any;

// Query
export const parseQuery: any;
export const flattenForGPU: any;

// Time
export const TimeController: any;

// Camera
export const CameraController: any;
export const MercatorCameraController: any;

// Math namespaces
export const mat4: any;
export const vec3: any;
export const geo: any;

// Projection
export const assertIsProjection: any;
export const SphericalProjection: any;
export const WebMercatorProjection: any;

// Charts
export const ChartManager: any;

// UI widgets
export const FeaturePopup: any;
export const UIManager: any;
export const AcetateFooter: any;
export const LayerManagerDialog: any;
export const GeocoderDialog: any;
export const TimePanel: any;
export const LoadingScreen: any;

// Symbology dialogs
export const SymbologyDialog: any;
export const LineSymbologyDialog: any;
export const PolygonSymbologyDialog: any;
export const H3SymbologyDialog: any;
export const RampEditorWidget: any;
