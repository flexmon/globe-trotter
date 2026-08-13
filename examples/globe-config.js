/**
 * Globe Trotter — Example Configuration
 *
 * This config mirrors the YAML configuration format used by the main app.
 * Pass it to engine.loadConfig(config) to load all layers with styling.
 *
 * Set your Mapbox token via a .env file:  VITE_MAPBOX_TOKEN=pk.eyJ...
 */

export const mapboxToken = import.meta.env?.VITE_MAPBOX_TOKEN || '';
export const googleMapsApiKey = import.meta.env?.VITE_GOOGLE_MAPS_API_KEY || '';

export default {
    basemap: {
        provider: 'google',
        style: 'google-satellite',
    },
    layers: [
        {
            name: 'Demand Metrics',
            type: 'h3f-sharded',
            url: '/globe-trotter/data/demand_metrics.manifest.json',
            extrusionScale: 0.012,
            style: {
                type: 'ramp',
                attribute: 'demand_mbps',
                domain: [0, 60],
                stops: ['#0D1A80', '#0D73BF', '#1ABF59', '#D9D91A', '#F23319'],
                opacityStops: [
                    { value: 0, opacity: 0.0 },
                    { value: 2, opacity: 0.3 },
                    { value: 15, opacity: 0.55 },
                    { value: 40, opacity: 0.75 },
                    { value: 60, opacity: 0.9 },
                ],
            },
        },
        {
            name: 'Aircraft Tracks',
            type: 'gfb-sharded',
            url: '/globe-trotter/data/aircraft_tracks.manifest.json',
            style: {
                type: 'categorical',
                attribute: 'airline',
                categories: {
                    Delta: '#001E70', United: '#003D87', American: '#B31B2C',
                    Southwest: '#E07816', JetBlue: '#003D9E', Alaska: '#004D80',
                    Spirit: '#FAD900', 'Air Canada': '#F21121', WestJet: '#00A16B',
                    Aeromexico: '#002E6B', 'British Airways': '#BA1228', Lufthansa: '#00286F',
                    'Air France': '#002E8C', KLM: '#00A1E3', Ryanair: '#0A3385',
                    'Turkish Airlines': '#E50D24', Swiss: '#E30021', Iberia: '#D6AB00',
                    SAS: '#002163', 'TAP Portugal': '#00876E', 'Singapore Airlines': '#003D87',
                    'Cathay Pacific': '#00604D', ANA: '#002E87', JAL: '#CC041C',
                    'Korean Air': '#0A4587', 'Thai Airways': '#611A8D', 'Air India': '#E05900',
                    Qantas: '#E50D24', 'Air New Zealand': '#001F3D', 'China Southern': '#003D87',
                    Emirates: '#D10014', 'Qatar Airways': '#5C1237', Etihad: '#B08C43',
                    Saudia: '#00664D', LATAM: '#001245', Avianca: '#E50D24',
                    GOL: '#FF7000', 'Ethiopian Airlines': '#008745', 'South African Airways': '#003387',
                },
                default: '#999999',
                opacity: 0.9,
            },
        },
    ],
};
