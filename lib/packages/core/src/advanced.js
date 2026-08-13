/**
 * @globe-trotter/core/advanced — Advanced / unstable surface.
 *
 * These exports expose engine internals (renderers, loaders, decoders, camera,
 * projection, math, UI widgets, …) for power users. Import them explicitly:
 *
 *   import { LayerManager, CameraController } from '@globe-trotter/core/advanced';
 *
 * ⚠️ Unlike the primary entry (`@globe-trotter/core`), these names are NOT part
 * of the stable contract and may change between releases.
 */

// ─── Rendering (single WebGPU renderers) ───
export { TileManager } from './tiles/TileManager.js';
export { GlobeRenderer } from './globe/GlobeRenderer.js';
export { TileRenderer } from './tiles/TileRenderer.js';
export { MercatorTileRenderer } from './tiles/MercatorTileRenderer.js';

// ─── Basemap Providers (used by TileManager) ───
export { BasemapProvider } from './tiles/providers/BasemapProvider.js';
export { MapboxProvider } from './tiles/providers/MapboxProvider.js';
export { GoogleProvider } from './tiles/providers/GoogleProvider.js';

// ─── Styling (compilers) ───
export { compileRampData, uploadRampTexture } from './styles/RampCompiler.js';
export { compileCategoricalData, uploadCategoricalTexture } from './styles/CategoricalCompiler.js';

// ─── Layer Management ───
export { LayerManager } from './layers/LayerManager.js';
export { H3FlexShards } from './layers/loaders/H3FlexShards.js';
export { DGFlexShards } from './layers/loaders/DGFlexShards.js';
export { MFBShards } from './layers/loaders/MFBShards.js';
export { GFBShards } from './layers/loaders/GFBShards.js';
export { VirtualH3Loader } from './layers/VirtualH3Loader.js';
export { StreamingGFBLoader } from './layers/loaders/StreamingGFBLoader.js';
export { LoaderRegistry } from './layers/loaders/registry.js';
export { GFBLineRenderer } from './layers/GFBLineRenderer.js';
export { GFBPolygonRenderer } from './layers/GFBPolygonRenderer.js';
export { getMeshFromCache, putMeshInCache } from './layers/MeshCache.js';
export {
  buildDenseEpochBuffer,
  computeEpochWindow,
  sliceEpoch,
  defaultH3StyleSpec,
} from './layers/H3EpochUtils.js';

// ─── Decoders ───
export { decodeH3Flex, decodeH3Mesh } from './layers/H3FlexDecoder.js';
export { decodeDGFlex, decodeDGFMesh } from './layers/DGFlexDecoder.js';
export { decodeGFB } from './layers/GFBDecoder.js';
export { decodeMFB } from './layers/MFBDecoder.js';
export { MFBDataSource } from './layers/MFBDataSource.js';

// ─── GeoJSON Loaders ───
export { parseGeoJSON } from './loaders/parseGeoJSON.js';
export { geojsonToFeatures } from './loaders/geojsonToFeatures.js';
export { splitFeatureCollectionByGeometry } from './loaders/splitFeatureCollectionByGeometry.js';

// ─── Picking ───
export { PickController } from './picking/PickController.js';
export { SpatialIndex } from './picking/SpatialIndex.js';

// ─── Query ───
export { parseQuery, flattenForGPU } from './query/QueryParser.js';

// ─── Time Control ───
export { TimeController } from './time/TimeController.js';

// ─── Camera ───
export { CameraController } from './camera/CameraController.js';
export { MercatorCameraController } from './camera/MercatorCameraController.js';

// ─── Math Utilities ───
export * as mat4 from './math/mat4.js';
export * as vec3 from './math/vec3.js';
export * as geo from './math/geo.js';

// ─── Projection ───
export { assertIsProjection } from './projection/IProjection.js';
export { SphericalProjection } from './projection/SphericalProjection.js';
export { WebMercatorProjection } from './projection/WebMercatorProjection.js';

// ─── Charts ───
export { ChartManager } from './charts/ChartManager.js';

// ─── UI Widgets ───
export { FeaturePopup } from './ui/FeaturePopup.js';
export { UIManager } from './ui/UIManager.js';
export { AcetateFooter } from './ui/AcetateFooter.js';
export { LayerManagerDialog } from './ui/LayerManagerDialog.js';
export { GeocoderDialog } from './ui/GeocoderDialog.js';
export { TimePanel } from './ui/TimePanel.js';
export { LoadingScreen } from './ui/LoadingScreen.js';

// ─── Symbology Dialogs ───
export { SymbologyDialog } from './ui/SymbologyDialog.js';
export { LineSymbologyDialog } from './ui/LineSymbologyDialog.js';
export { PolygonSymbologyDialog } from './ui/PolygonSymbologyDialog.js';
export { H3SymbologyDialog } from './ui/H3SymbologyDialog.js';
export { RampEditorWidget } from './ui/RampEditorWidget.js';
