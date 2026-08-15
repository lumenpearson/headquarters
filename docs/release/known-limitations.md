# Known release limitations

- Final production photography, video, map plates and local font files were not present in the
  repository at project bootstrap. Their manifest entries remain explicit `placeholder` or `missing`
  statuses and render through the safe asset pipeline.
- Camera-based moire/readability approval and the two-hour long-run test require the actual production
  monitors and cannot be truthfully completed on a development workstation.
- Local production mount paths are intentionally uncommitted. They are configured per shoot machine.
- Browser directory access must be granted again after a full browser profile reset; Tauri and the
  localhost bridge are the persistent alternatives.
- The committed asset manifest intentionally contains local SVG placeholders because final approved
  production media was not supplied with the specification. Every referenced asset ID is present and
  can be replaced through the ignored runtime override.
- Yandex Maps JavaScript API 2.1 requires a user-provided browser key and network access to Yandex
  map domains. No account credential or API key is committed. Without a key the tactical screen keeps
  all operational panels available and exposes a local key-configuration state instead of a fake map.
- The bundled surveillance loop and twelve thumbnails are demonstration media derived from the
  supplied visual references. Production RTSP/HLS/WebRTC endpoints still have to be provisioned by the
  deployment environment; the player controls and channel switching are already functional locally.
