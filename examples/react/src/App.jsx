import { useEffect, useRef } from 'react';
import { GlobeTrotterEngine } from '@globe-trotter/core';
import config, { mapboxToken, googleMapsApiKey } from '../../globe-config.js';

export default function App() {
    const canvasRef = useRef(null);

    useEffect(() => {
        let destroyed = false;

        (async () => {
            const engine = new GlobeTrotterEngine(canvasRef.current, {
                mapboxToken,
                googleMapsApiKey,
                basePath: '/globe-trotter/',
                camera: { center: [39.0, -98.0], altitude: 12000 },
                time: { enabled: true, autoplay: true, speed: 60 },
                ui: true,
                uiWidgets: {
                    footer: true, layers: true, geocoder: true, time: true,
                    loadingScreen: {
                        logoUrl: `${import.meta.env.BASE_URL}assets/example-logo.svg`,
                        iconUrl: `${import.meta.env.BASE_URL}assets/example-icon.svg`,
                        subtitle: 'React Example',
                    },
                },
            });

            if (destroyed) { engine.destroy(); return; }

            await engine.loadConfig(config);
            window.globe = engine;
        })();

        return () => { destroyed = true; window.globe?.destroy(); };
    }, []);

    return <canvas ref={canvasRef} style={{ width: '100vw', height: '100vh', display: 'block' }} />;
}
