'use client';

import type { Alert, OperationalObject, Sector, Sensor, TacticalRoute } from '@gremuchaya/domain';
import type YandexMaps from 'yandex-maps';
import Script from 'next/script';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { TerminalButton, TerminalInput } from '@gremuchaya/ui/primitives';

import type { MapLayer } from '@/state/operationsStore';

const buildTimeApiKey = process.env.NEXT_PUBLIC_YANDEX_MAPS_API_KEY?.trim() ?? '';
const localApiKeyStorageKey = 'gremuchaya-hq:yandex-maps-api-key';
const localApiKeyChangeEvent = 'gremuchaya-hq:yandex-maps-api-key-changed';
type YandexMapsApi = typeof YandexMaps;
type YandexMapInstance = InstanceType<YandexMapsApi['Map']>;
type YandexCollectionInstance = InstanceType<YandexMapsApi['GeoObjectCollection']>;

declare global {
  interface Window {
    readonly ymaps?: YandexMapsApi;
  }
}

interface YandexTacticalMapProps {
  readonly center: readonly [number, number];
  readonly zoom: number;
  readonly layers: Readonly<Record<MapLayer, boolean>>;
  readonly objects: readonly OperationalObject[];
  readonly routes: readonly TacticalRoute[];
  readonly alerts: readonly Alert[];
  readonly sensors: readonly Sensor[];
  readonly sectors: Readonly<Record<string, Sector>>;
  readonly selectedObjectId: string;
  readonly selectedRouteId: string;
  readonly onSelectObject: (id: string) => void;
  readonly onSelectRoute: (id: string) => void;
  readonly onOpenAlert: (id: string) => void;
  readonly onMapViewChange: (center: readonly [number, number], zoom: number) => void;
}

type LoadState = 'awaiting-key' | 'loading' | 'ready' | 'error';

function markerPreset(object: OperationalObject) {
  if (object.threat >= 70) return 'islands#redCircleDotIconWithCaption';
  if (object.kind === 'group') return 'islands#greenCircleDotIconWithCaption';
  if (object.kind === 'device' || object.kind === 'point') {
    return 'islands#orangeCircleDotIconWithCaption';
  }
  return 'islands#grayCircleDotIconWithCaption';
}

function routeColor(route: TacticalRoute, selectedRouteId: string): string {
  if (route.id === selectedRouteId) return '#ff3d00';
  if (route.risk >= 65) return '#f27622';
  return '#42b97b';
}

function sameCoordinate(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.00001;
}

function subscribeLocalApiKey(onStoreChange: () => void): () => void {
  window.addEventListener('storage', onStoreChange);
  window.addEventListener(localApiKeyChangeEvent, onStoreChange);
  return () => {
    window.removeEventListener('storage', onStoreChange);
    window.removeEventListener(localApiKeyChangeEvent, onStoreChange);
  };
}

function readLocalApiKey(): string {
  return localStorage.getItem(localApiKeyStorageKey)?.trim() ?? '';
}

function readServerApiKey(): string {
  return '';
}

export function YandexTacticalMap({
  center,
  zoom,
  layers,
  objects,
  routes,
  alerts,
  sensors,
  sectors,
  selectedObjectId,
  selectedRouteId,
  onSelectObject,
  onSelectRoute,
  onOpenAlert,
  onMapViewChange,
}: YandexTacticalMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<YandexMapInstance | null>(null);
  const tacticalCollectionRef = useRef<YandexCollectionInstance | null>(null);
  const suppressViewEventRef = useRef(false);
  const initialViewRef = useRef({ center, zoom });
  const localApiKey = useSyncExternalStore(subscribeLocalApiKey, readLocalApiKey, readServerApiKey);
  const configuredApiKey = buildTimeApiKey || localApiKey;
  const [keyInput, setKeyInput] = useState('');
  const [scriptVersion, setScriptVersion] = useState(0);
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>(
    buildTimeApiKey === '' ? 'awaiting-key' : 'loading',
  );
  const effectiveLoadState =
    configuredApiKey !== '' && loadState === 'awaiting-key' ? 'loading' : loadState;

  const scriptSource = useMemo(() => {
    if (configuredApiKey === '') return null;
    const parameters = new URLSearchParams({
      apikey: configuredApiKey,
      lang: 'ru_RU',
      csp: 'true',
      load: 'package.full',
    });
    return `https://api-maps.yandex.ru/2.1.77/?${parameters.toString()}`;
  }, [configuredApiKey]);

  useEffect(() => {
    const api = window.ymaps;
    if (!scriptLoaded || containerRef.current === null || api === undefined) return;

    let disposed = false;
    void api.ready(() => {
      if (disposed || containerRef.current === null || mapRef.current !== null) return;

      const map = new api.Map(
        containerRef.current,
        {
          center: [...initialViewRef.current.center],
          zoom: initialViewRef.current.zoom,
          controls: [],
          type: 'yandex#map',
        },
        {
          autoFitToViewport: 'always',
          avoidFractionalZoom: false,
          suppressMapOpenBlock: true,
          yandexMapDisablePoiInteractivity: true,
        },
      );

      map.controls.add('zoomControl', {
        float: 'none',
        position: { right: 12, bottom: 72 },
      });

      map.events.add('boundschange', () => {
        if (suppressViewEventRef.current) return;
        const nextCenter = map.getCenter();
        const nextZoom = map.getZoom();
        onMapViewChange(
          [
            nextCenter[0] ?? initialViewRef.current.center[0],
            nextCenter[1] ?? initialViewRef.current.center[1],
          ],
          nextZoom,
        );
      });

      mapRef.current = map;
      tacticalCollectionRef.current = new api.GeoObjectCollection();
      map.geoObjects.add(tacticalCollectionRef.current);
      setLoadState('ready');
    });

    return () => {
      disposed = true;
      mapRef.current?.destroy();
      mapRef.current = null;
      tacticalCollectionRef.current = null;
    };
  }, [onMapViewChange, scriptLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (map === null) return;
    const currentCenter = map.getCenter();
    const currentZoom = map.getZoom();
    if (
      sameCoordinate(currentCenter[0] ?? 0, center[0]) &&
      sameCoordinate(currentCenter[1] ?? 0, center[1]) &&
      Math.abs(currentZoom - zoom) < 0.01
    ) {
      return;
    }

    suppressViewEventRef.current = true;
    void map.setCenter([...center], zoom, { duration: 180 }).finally(() => {
      suppressViewEventRef.current = false;
    });
  }, [center, zoom]);

  useEffect(() => {
    const map = mapRef.current;
    const collection = tacticalCollectionRef.current;
    const api = window.ymaps;
    if (map === null || collection === null || loadState !== 'ready' || api === undefined) return;

    collection.removeAll();

    for (const object of objects) {
      const placemark = new api.Placemark(
        [object.position.lat, object.position.lng],
        {
          iconCaption: object.id,
          hintContent: `${object.id} / ${object.callsign} / ${object.signal}%`,
          balloonContentHeader: `${object.id} / ${object.callsign}`,
          balloonContentBody: `${object.name}<br>${object.status}<br>Сигнал: ${object.signal}%`,
        },
        {
          preset: markerPreset(object),
          iconColor: object.id === selectedObjectId ? '#ff3d00' : undefined,
          zIndex: object.id === selectedObjectId ? 900 : 300,
        },
      );
      placemark.events.add('click', () => onSelectObject(object.id));
      collection.add(placemark);
    }

    if (layers.routes) {
      for (const route of routes) {
        const polyline = new api.Polyline(
          route.points.map((point) => [point.lat, point.lng]),
          { hintContent: `${route.id} / ${route.name} / RISK ${route.risk}%` },
          {
            strokeColor: routeColor(route, selectedRouteId),
            strokeOpacity: route.id === selectedRouteId ? 1 : 0.75,
            strokeWidth: route.id === selectedRouteId ? 5 : 3,
            strokeStyle: route.id === selectedRouteId ? 'solid' : 'dash',
          },
        );
        polyline.events.add('click', () => onSelectRoute(route.id));
        collection.add(polyline);
      }
    }

    if (layers.restricted) {
      const restrictedZones = [
        [
          [55.757, 37.606],
          [55.763, 37.622],
          [55.756, 37.636],
          [55.748, 37.625],
          [55.749, 37.61],
        ],
        [
          [55.724, 37.55],
          [55.733, 37.574],
          [55.721, 37.594],
          [55.708, 37.578],
        ],
      ];
      for (const coordinates of restrictedZones) {
        collection.add(
          new api.Polygon(
            [coordinates],
            { hintContent: 'ЗОНА ОГРАНИЧЕНИЙ' },
            {
              fillColor: '#ff3d0022',
              strokeColor: '#ff3d00',
              strokeOpacity: 0.85,
              strokeWidth: 2,
              strokeStyle: 'dash',
            },
          ),
        );
      }
    }

    if (layers.alerts) {
      for (const alert of alerts) {
        const placemark = new api.Placemark(
          [alert.coordinates.lat, alert.coordinates.lng],
          {
            iconCaption: '!',
            hintContent: `${alert.id} / ${alert.title}`,
          },
          {
            preset: 'islands#redStretchyIcon',
            zIndex: 1000,
          },
        );
        placemark.events.add('click', () => onOpenAlert(alert.id));
        collection.add(placemark);
      }
    }

    if (layers.sensors) {
      for (const sensor of sensors) {
        const sector = sectors[sensor.sectorId];
        if (sector === undefined) continue;
        collection.add(
          new api.Placemark(
            [sector.center.lat, sector.center.lng],
            { iconCaption: sensor.id, hintContent: `${sensor.name} / ${sensor.signal}%` },
            { preset: 'islands#darkGreenCircleDotIconWithCaption', zIndex: 180 },
          ),
        );
      }
    }

    map.container.fitToViewport(true);
  }, [
    alerts,
    layers.alerts,
    layers.restricted,
    layers.routes,
    layers.sensors,
    loadState,
    objects,
    onOpenAlert,
    onSelectObject,
    onSelectRoute,
    routes,
    sectors,
    selectedObjectId,
    selectedRouteId,
    sensors,
  ]);

  useEffect(() => {
    const element = containerRef.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => mapRef.current?.container.fitToViewport(true));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="yandex-tactical-map" aria-label="Тактическая карта Yandex Maps API 2.1">
      {scriptSource === null ? null : (
        <Script
          id={`yandex-maps-api-v2-${scriptVersion}`}
          src={scriptSource}
          strategy="afterInteractive"
          onLoad={() => setScriptLoaded(true)}
          onReady={() => setScriptLoaded(true)}
          onError={() => setLoadState('error')}
        />
      )}
      <div ref={containerRef} className="yandex-tactical-map__canvas" />
      <div className="yandex-tactical-map__shade" aria-hidden="true" />
      {effectiveLoadState === 'awaiting-key' ? (
        <div className="yandex-tactical-map__status">
          <strong>[ YANDEX MAPS API 2.1 // KEY REQUIRED ]</strong>
          <span>Введите JavaScript API-ключ Яндекс.Карт для этого устройства</span>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const nextApiKey = keyInput.trim();
              if (nextApiKey === '') return;
              localStorage.setItem(localApiKeyStorageKey, nextApiKey);
              window.dispatchEvent(new Event(localApiKeyChangeEvent));
              setKeyInput('');
              setScriptVersion((version) => version + 1);
              setLoadState('loading');
            }}
          >
            <TerminalInput
              type="password"
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value)}
              placeholder="API key"
              autoComplete="off"
              spellCheck={false}
              aria-label="Ключ Yandex Maps API"
            />
            <TerminalButton tone="primary" type="submit">
              [APPLY] ПОДКЛЮЧИТЬ
            </TerminalButton>
          </form>
          <small>
            Ключ хранится локально. Для сборки можно использовать NEXT_PUBLIC_YANDEX_MAPS_API_KEY.
          </small>
        </div>
      ) : effectiveLoadState === 'error' ? (
        <div className="yandex-tactical-map__status is-error">
          <strong>[ MAP PROVIDER UNAVAILABLE ]</strong>
          <span>Проверьте ключ, доступ к api-maps.yandex.ru и ограничения домена.</span>
          {buildTimeApiKey === '' ? (
            <TerminalButton
              onClick={() => {
                localStorage.removeItem(localApiKeyStorageKey);
                window.dispatchEvent(new Event(localApiKeyChangeEvent));
                setScriptLoaded(false);
                setScriptVersion((version) => version + 1);
                setLoadState('awaiting-key');
              }}
            >
              [R] ЗАМЕНИТЬ КЛЮЧ
            </TerminalButton>
          ) : null}
        </div>
      ) : effectiveLoadState === 'loading' ? (
        <div className="yandex-tactical-map__status">
          <strong>[ INITIALIZING YANDEX VECTOR LAYER... ]</strong>
          <span>API 2.1 / CSP MODE / RU_RU</span>
        </div>
      ) : null}
      <div className="yandex-tactical-map__hud" aria-hidden="true">
        <span className="map-north">
          N<br />↑
        </span>
        <span className="map-scale">0 ├────┼────┤ 2 KM</span>
        <i>+</i>
      </div>
    </section>
  );
}
