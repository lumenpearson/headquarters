'use client';

import type { Alert, OperationalObject, Sector, Sensor, TacticalRoute } from '@gremuchaya/domain';
import Script from 'next/script';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { TerminalButton, TerminalInput } from '@gremuchaya/ui/primitives';

import { useTranslate } from '@/application/localization/locale';
import type { MapLayer } from '@/state/operationsStore';

/**
 * The operations store deliberately keeps geographic positions as
 * `[latitude, longitude]`, which is convenient for its non-provider UI.
 * JavaScript API v3 uses the industry-standard `[longitude, latitude]`.
 * This adapter is the only place that crosses that boundary.
 */
type OperationsCoordinate = readonly [number, number];
type YandexCoordinate = readonly [number, number];

interface YandexMapEntity {
  readonly id?: string;
}

interface YandexMapCollection extends YandexMapEntity {
  readonly children: readonly YandexMapEntity[];
  addChild(entity: YandexMapEntity): YandexMapCollection;
  removeChild(entity: YandexMapEntity): YandexMapCollection;
}

interface YandexMapInstance extends YandexMapEntity {
  addChild(entity: YandexMapEntity): YandexMapInstance;
  removeChild(entity: YandexMapEntity): YandexMapInstance;
  update(props: {
    readonly location?: {
      readonly center: YandexCoordinate;
      readonly zoom: number;
      readonly duration?: number;
      readonly easing?: string;
    };
  }): void;
  destroy(): void;
}

interface YandexMapUpdate {
  readonly location: {
    readonly center: readonly number[];
    readonly zoom: number;
  };
}

interface YandexMapsV3Api {
  readonly ready: Promise<void>;
  readonly YMap: new (
    container: HTMLElement,
    props: {
      readonly location: {
        readonly center: YandexCoordinate;
        readonly zoom: number;
      };
      readonly behaviors?: readonly string[];
      readonly mode?: 'auto' | 'raster' | 'vector';
      readonly showScaleInCopyrights?: boolean;
    },
    children?: readonly YandexMapEntity[],
  ) => YandexMapInstance;
  readonly YMapDefaultSchemeLayer: new (props?: {
    readonly customization?: unknown;
  }) => YandexMapEntity;
  readonly YMapDefaultFeaturesLayer: new (props?: Record<string, never>) => YandexMapEntity;
  readonly YMapCollection: new (props?: Record<string, never>) => YandexMapCollection;
  readonly YMapFeature: new (props: {
    readonly id?: string;
    readonly geometry:
      | { readonly type: 'LineString'; readonly coordinates: readonly YandexCoordinate[] }
      | {
          readonly type: 'Polygon';
          readonly coordinates: readonly (readonly YandexCoordinate[])[];
        };
    readonly style: {
      readonly cursor?: string;
      readonly fill?: string;
      readonly fillOpacity?: number;
      readonly stroke?: readonly {
        readonly color: string;
        readonly width: number;
        readonly dash?: readonly number[];
        readonly opacity?: number;
      }[];
      readonly zIndex?: number;
    };
    readonly onClick?: () => void;
  }) => YandexMapEntity;
  readonly YMapMarker: new (
    props: {
      readonly id?: string;
      readonly coordinates: YandexCoordinate;
      readonly zIndex?: number;
    },
    element: HTMLElement,
  ) => YandexMapEntity;
  readonly YMapListener: new (props: {
    readonly onUpdate?: (update: YandexMapUpdate) => void;
  }) => YandexMapEntity;
}

declare global {
  interface Window {
    readonly ymaps3?: YandexMapsV3Api;
  }
}

interface YandexTacticalMapProps {
  readonly center: OperationsCoordinate;
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
  readonly onMapViewChange: (center: OperationsCoordinate, zoom: number) => void;
}

type LoadState = 'awaiting-key' | 'loading' | 'ready' | 'error';

const buildTimeApiKey = process.env.NEXT_PUBLIC_YANDEX_MAPS_API_KEY?.trim() ?? '';
const localApiKeyStorageKey = 'gremuchaya-hq:yandex-maps-v3-api-key';
const legacyLocalApiKeyStorageKey = 'gremuchaya-hq:yandex-maps-api-key';
const localApiKeyChangeEvent = 'gremuchaya-hq:yandex-maps-api-key-changed';
const yandexMapsScriptId = 'yandex-maps-api-v3';

const terminalMapCustomization = {
  style: [
    {
      tags: { any: ['water'] },
      elements: 'geometry',
      stylers: [{ color: '#071119' }],
    },
    {
      tags: { any: ['landscape', 'admin', 'land', 'transit'] },
      elements: 'geometry',
      stylers: [{ color: '#111411' }],
    },
    {
      tags: { any: ['building'] },
      elements: 'geometry',
      stylers: [{ color: '#30332f' }],
    },
    {
      tags: { any: ['road'] },
      elements: 'geometry',
      stylers: [{ color: '#4d4035' }],
    },
    {
      tags: { any: ['poi'] },
      stylers: [{ visibility: 'off' }],
    },
  ],
} as const;

function toYandexCoordinate(position: OperationsCoordinate): YandexCoordinate {
  return [position[1], position[0]];
}

function toOperationsCoordinate(position: readonly number[]): OperationsCoordinate | null {
  const [longitude, latitude] = position;
  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return null;
  }
  return [latitude, longitude];
}

function sameCoordinate(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.00001;
}

function sameMapView(
  left: { readonly center: OperationsCoordinate; readonly zoom: number } | null,
  right: { readonly center: OperationsCoordinate; readonly zoom: number },
): boolean {
  return (
    left !== null &&
    sameCoordinate(left.center[0], right.center[0]) &&
    sameCoordinate(left.center[1], right.center[1]) &&
    Math.abs(left.zoom - right.zoom) < 0.01
  );
}

function markerTone(object: OperationalObject): 'friendly' | 'hostile' | 'neutral' {
  if (object.threat >= 70) return 'hostile';
  if (object.kind === 'group') return 'friendly';
  return 'neutral';
}

function routeColor(route: TacticalRoute, selectedRouteId: string): string {
  if (route.id === selectedRouteId) return '#ff3d00';
  if (route.risk >= 65) return '#f27622';
  return '#42b97b';
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

function createMarkerElement(
  className: string,
  label: string,
  detail: string,
  onActivate?: () => void,
): HTMLElement {
  const marker = document.createElement(onActivate === undefined ? 'span' : 'button');
  marker.className = className;
  marker.setAttribute('aria-label', detail);
  marker.title = detail;
  if (marker instanceof HTMLButtonElement && onActivate !== undefined) {
    marker.type = 'button';
    marker.addEventListener('click', onActivate);
    marker.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onActivate();
    });
  } else {
    marker.setAttribute('role', 'img');
  }

  const signal = document.createElement('i');
  signal.setAttribute('aria-hidden', 'true');
  const caption = document.createElement('span');
  caption.textContent = label;
  marker.append(signal, caption);
  return marker;
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
  const translate = useTranslate();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<YandexMapInstance | null>(null);
  const overlayRef = useRef<YandexMapCollection | null>(null);
  const initialViewRef = useRef({ center, zoom });
  const lastProviderViewRef = useRef<{ center: OperationsCoordinate; zoom: number } | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingViewRef = useRef<{ center: OperationsCoordinate; zoom: number } | null>(null);
  const onMapViewChangeRef = useRef(onMapViewChange);
  const onSelectObjectRef = useRef(onSelectObject);
  const onSelectRouteRef = useRef(onSelectRoute);
  const onOpenAlertRef = useRef(onOpenAlert);
  const localApiKey = useSyncExternalStore(subscribeLocalApiKey, readLocalApiKey, readServerApiKey);
  const configuredApiKey = buildTimeApiKey || localApiKey;
  const [keyInput, setKeyInput] = useState('');
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
    });
    return `https://api-maps.yandex.ru/v3/?${parameters.toString()}`;
  }, [configuredApiKey]);

  useEffect(() => {
    onMapViewChangeRef.current = onMapViewChange;
    onSelectObjectRef.current = onSelectObject;
    onSelectRouteRef.current = onSelectRoute;
    onOpenAlertRef.current = onOpenAlert;
  }, [onMapViewChange, onOpenAlert, onSelectObject, onSelectRoute]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  useEffect(() => {
    const api = window.ymaps3;
    if (
      !scriptLoaded ||
      configuredApiKey === '' ||
      api === undefined ||
      containerRef.current === null
    ) {
      return;
    }

    let disposed = false;
    setLoadState('loading');
    void api.ready
      .then(() => {
        if (disposed || containerRef.current === null || mapRef.current !== null) return;

        const map = new api.YMap(
          containerRef.current,
          {
            location: {
              center: toYandexCoordinate(initialViewRef.current.center),
              zoom: initialViewRef.current.zoom,
            },
            behaviors: ['drag', 'scrollZoom', 'pinchZoom', 'dblClick'],
            mode: 'vector',
            showScaleInCopyrights: true,
          },
          [
            new api.YMapDefaultSchemeLayer({ customization: terminalMapCustomization }),
            new api.YMapDefaultFeaturesLayer({}),
          ],
        );

        map.addChild(
          new api.YMapListener({
            onUpdate: ({ location }) => {
              const nextCenter = toOperationsCoordinate(location.center);
              if (nextCenter === null || !Number.isFinite(location.zoom)) return;
              const nextView = { center: nextCenter, zoom: location.zoom };
              if (sameMapView(lastProviderViewRef.current, nextView)) return;
              lastProviderViewRef.current = nextView;
              pendingViewRef.current = nextView;
              if (frameRef.current !== null) return;
              frameRef.current = requestAnimationFrame(() => {
                frameRef.current = null;
                const pending = pendingViewRef.current;
                pendingViewRef.current = null;
                if (pending !== null) onMapViewChangeRef.current(pending.center, pending.zoom);
              });
            },
          }),
        );

        mapRef.current = map;
        lastProviderViewRef.current = {
          center: initialViewRef.current.center,
          zoom: initialViewRef.current.zoom,
        };
        setLoadState('ready');
      })
      .catch(() => {
        if (!disposed) setLoadState('error');
      });

    return () => {
      disposed = true;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      overlayRef.current = null;
      mapRef.current?.destroy();
      mapRef.current = null;
      lastProviderViewRef.current = null;
    };
  }, [configuredApiKey, scriptLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    const nextView = { center, zoom };
    if (
      map === null ||
      loadState !== 'ready' ||
      sameMapView(lastProviderViewRef.current, nextView)
    ) {
      return;
    }
    lastProviderViewRef.current = nextView;
    map.update({
      location: {
        center: toYandexCoordinate(center),
        zoom,
        duration: 180,
        easing: 'ease-in-out',
      },
    });
  }, [center, loadState, zoom]);

  useEffect(() => {
    const map = mapRef.current;
    const api = window.ymaps3;
    if (map === null || api === undefined || loadState !== 'ready') return;

    const previousOverlay = overlayRef.current;
    if (previousOverlay !== null) map.removeChild(previousOverlay);

    const overlay = new api.YMapCollection({});
    overlayRef.current = overlay;
    map.addChild(overlay);

    for (const object of objects) {
      const tone = markerTone(object);
      const marker = createMarkerElement(
        `yandex-tactical-marker yandex-tactical-marker--${tone}${
          object.id === selectedObjectId ? ' is-selected' : ''
        }`,
        object.id,
        `${object.id} / ${object.callsign} / ${object.signal}%`,
        () => onSelectObjectRef.current(object.id),
      );
      overlay.addChild(
        new api.YMapMarker(
          {
            id: `object-${object.id}`,
            coordinates: toYandexCoordinate([object.position.lat, object.position.lng]),
            zIndex: object.id === selectedObjectId ? 2400 : 2200,
          },
          marker,
        ),
      );
    }

    if (layers.routes) {
      for (const route of routes) {
        overlay.addChild(
          new api.YMapFeature({
            id: `route-${route.id}`,
            geometry: {
              type: 'LineString',
              coordinates: route.points.map((point) => toYandexCoordinate([point.lat, point.lng])),
            },
            style: {
              cursor: 'pointer',
              zIndex: route.id === selectedRouteId ? 2100 : 2000,
              stroke: [
                {
                  color: routeColor(route, selectedRouteId),
                  width: route.id === selectedRouteId ? 5 : 3,
                  opacity: route.id === selectedRouteId ? 1 : 0.76,
                  ...(route.id === selectedRouteId ? {} : { dash: [6, 8] }),
                },
              ],
            },
            onClick: () => onSelectRouteRef.current(route.id),
          }),
        );
      }
    }

    if (layers.restricted) {
      const restrictedZones: readonly (readonly OperationsCoordinate[])[] = [
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
      for (const [index, coordinates] of restrictedZones.entries()) {
        overlay.addChild(
          new api.YMapFeature({
            id: `restricted-${index}`,
            geometry: {
              type: 'Polygon',
              coordinates: [coordinates.map(toYandexCoordinate)],
            },
            style: {
              cursor: 'crosshair',
              fill: '#ff3d00',
              fillOpacity: 0.12,
              zIndex: 1800,
              stroke: [{ color: '#ff3d00', width: 2, opacity: 0.85, dash: [6, 5] }],
            },
          }),
        );
      }
    }

    if (layers.alerts) {
      for (const alert of alerts) {
        const marker = createMarkerElement(
          'yandex-tactical-marker yandex-tactical-marker--alert',
          '!',
          `${alert.id} / ${alert.title}`,
          () => onOpenAlertRef.current(alert.id),
        );
        overlay.addChild(
          new api.YMapMarker(
            {
              id: `alert-${alert.id}`,
              coordinates: toYandexCoordinate([alert.coordinates.lat, alert.coordinates.lng]),
              zIndex: 2600,
            },
            marker,
          ),
        );
      }
    }

    if (layers.sensors) {
      for (const sensor of sensors) {
        const sector = sectors[sensor.sectorId];
        if (sector === undefined) continue;
        const marker = createMarkerElement(
          'yandex-tactical-marker yandex-tactical-marker--sensor',
          sensor.id,
          `${sensor.name} / ${sensor.signal}%`,
        );
        overlay.addChild(
          new api.YMapMarker(
            {
              id: `sensor-${sensor.id}`,
              coordinates: toYandexCoordinate([sector.center.lat, sector.center.lng]),
              zIndex: 1900,
            },
            marker,
          ),
        );
      }
    }

    return () => {
      if (overlayRef.current !== overlay) return;
      overlayRef.current = null;
      try {
        map.removeChild(overlay);
      } catch {
        // The provider can already be destroyed during React effect teardown.
      }
    };
  }, [
    alerts,
    layers.alerts,
    layers.restricted,
    layers.routes,
    layers.sensors,
    loadState,
    objects,
    routes,
    sectors,
    selectedObjectId,
    selectedRouteId,
    sensors,
  ]);

  useEffect(() => {
    const element = containerRef.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const map = mapRef.current;
      const lastView = lastProviderViewRef.current;
      if (map === null || lastView === null) return;
      map.update({
        location: { center: toYandexCoordinate(lastView.center), zoom: lastView.zoom },
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const providerFallback = (
    <aside
      className="yandex-tactical-map__fallback"
      aria-label={translate('yandexMap.fallbackAriaLabel')}
    >
      <header>
        <strong>{translate('yandexMap.fallbackHeading')}</strong>
        <span>{translate('yandexMap.offlineStatus')}</span>
      </header>
      <dl>
        <div>
          <dt>{translate('yandexMap.centerLabel')}</dt>
          <dd>{center.map((value) => value.toFixed(5)).join(' / ')}</dd>
        </div>
        <div>
          <dt>{translate('yandexMap.scaleLabel')}</dt>
          <dd>Z{zoom.toFixed(1)}</dd>
        </div>
        <div>
          <dt>{translate('field.objects')}</dt>
          <dd>{objects.length}</dd>
        </div>
        <div>
          <dt>{translate('map.layerRoutes')}</dt>
          <dd>{routes.length}</dd>
        </div>
      </dl>
      <ol>
        {objects.slice(0, 5).map((object) => (
          <li key={object.id} data-selected={object.id === selectedObjectId || undefined}>
            <span>{object.id}</span>
            <span>
              {object.position.lat.toFixed(4)}, {object.position.lng.toFixed(4)}
            </span>
          </li>
        ))}
      </ol>
    </aside>
  );

  return (
    <section className="yandex-tactical-map" aria-label={translate('yandexMap.sectionAriaLabel')}>
      {scriptSource === null ? null : (
        <Script
          id={yandexMapsScriptId}
          src={scriptSource}
          strategy="afterInteractive"
          onLoad={() => setScriptLoaded(true)}
          onReady={() => setScriptLoaded(true)}
          onError={() => setLoadState('error')}
        />
      )}
      <div ref={containerRef} className="yandex-tactical-map__canvas" />
      <div className="yandex-tactical-map__shade" aria-hidden="true" />
      {effectiveLoadState !== 'ready' ? providerFallback : null}
      {effectiveLoadState === 'awaiting-key' ? (
        <div className="yandex-tactical-map__status">
          <strong>{translate('yandexMap.keyRequiredHeading')}</strong>
          <span>{translate('yandexMap.keyRequiredHint')}</span>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const nextApiKey = keyInput.trim();
              if (nextApiKey === '') return;
              localStorage.setItem(localApiKeyStorageKey, nextApiKey);
              localStorage.removeItem(legacyLocalApiKeyStorageKey);
              window.dispatchEvent(new Event(localApiKeyChangeEvent));
              window.location.reload();
            }}
          >
            <TerminalInput
              type="password"
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value)}
              placeholder={translate('yandexMap.keyInputPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              aria-label={translate('yandexMap.keyInputAriaLabel')}
            />
            <TerminalButton tone="primary" type="submit">
              {translate('yandexMap.applyKeyButton')}
            </TerminalButton>
          </form>
          <small>
            {translate('yandexMap.keyStorageHint', { envVar: 'NEXT_PUBLIC_YANDEX_MAPS_API_KEY' })}
          </small>
        </div>
      ) : effectiveLoadState === 'error' ? (
        <div className="yandex-tactical-map__status is-error">
          <strong>{translate('yandexMap.providerUnavailableHeading')}</strong>
          <span>{translate('yandexMap.providerUnavailableHint')}</span>
          {buildTimeApiKey === '' ? (
            <TerminalButton
              onClick={() => {
                localStorage.removeItem(localApiKeyStorageKey);
                localStorage.removeItem(legacyLocalApiKeyStorageKey);
                window.dispatchEvent(new Event(localApiKeyChangeEvent));
                setScriptLoaded(false);
                setLoadState('awaiting-key');
              }}
            >
              {translate('yandexMap.replaceKeyButton')}
            </TerminalButton>
          ) : null}
        </div>
      ) : effectiveLoadState === 'loading' ? (
        <div className="yandex-tactical-map__status">
          <strong>{translate('yandexMap.initializingHeading')}</strong>
          {/* A fixed protocol/version readout, not chrome -- see the wave's report. */}
          <span>JAVASCRIPT API V3 / WEBGL / VECTOR MODE / RU_RU</span>
        </div>
      ) : null}
      <div className="yandex-tactical-map__hud" aria-hidden="true">
        <span className="map-north">
          N<br />↑
        </span>
        {/* A fixed protocol/version readout, not chrome -- see the wave's report. */}
        <span className="map-scale">YANDEX V3 ├───┼───┤</span>
        <i>+</i>
      </div>
    </section>
  );
}
