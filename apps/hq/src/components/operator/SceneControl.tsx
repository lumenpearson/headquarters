'use client';

import { useEffect, useState } from 'react';
import { TerminalButton, TerminalSelect } from '@gremuchaya/ui/primitives';
import type { TerminalSelectOption } from '@gremuchaya/ui/primitives';

import { sceneMetadata } from '@/config/scenes';
import { useRuntime } from '@/components/runtime/RuntimeProvider';
import { useAppStore } from '@/state/appStore';

const sceneOptions: ReadonlyArray<TerminalSelectOption<string>> = [
  { value: '', label: 'ВЫБЕРИТЕ СЦЕНУ', disabled: true },
  ...sceneMetadata.map((scene) => ({
    value: scene.id,
    label: `${scene.shootDate.slice(5)} / ${scene.id} / ${scene.title}`,
  })),
];

export function SceneControl() {
  const { controller } = useRuntime();
  const activeSceneId = useAppStore((state) => state.scene.activeSceneId);
  const cueIndex = useAppStore((state) => state.scene.activeCueIndex);
  const preflight = useAppStore((state) => state.scene.preflight);
  const [cueLabels, setCueLabels] = useState<readonly string[]>([]);

  useEffect(() => {
    if (controller === null || activeSceneId === null) return;
    let active = true;
    void controller.getScene(activeSceneId).then((scene) => {
      if (active) setCueLabels(scene?.cues.map((cue) => cue.label) ?? []);
    });
    return () => {
      active = false;
    };
  }, [activeSceneId, controller]);

  const load = async (sceneId: string) => {
    if (controller === null) return;
    const scene = await controller.loadScene(sceneId);
    setCueLabels(scene.cues.map((cue) => cue.label));
  };

  return (
    <section className="scene-control hq-panel">
      <header className="hq-panel__header">
        <div>
          <span className="hq-panel__eyebrow">OPERATOR / SCENE</span>
          <h2 className="hq-panel__title">УПРАВЛЕНИЕ СЦЕНОЙ</h2>
        </div>
        <span className={preflight?.ready === true ? 'status-ok' : 'status-warn'}>
          {preflight?.ready === true ? 'PREFLIGHT OK' : 'CHECK'}
        </span>
      </header>
      <div className="scene-control__select">
        <TerminalSelect
          value={activeSceneId ?? ''}
          options={sceneOptions}
          onValueChange={(sceneId) => void load(sceneId)}
          label="Операционная сцена"
        />
      </div>
      <div className="transport">
        <TerminalButton onClick={() => controller?.sceneService.previousCue()}>
          [F7] PREV
        </TerminalButton>
        <TerminalButton
          tone="primary"
          className="transport__go"
          onClick={() => controller?.sceneService.nextCue()}
        >
          [F8] GO / NEXT
        </TerminalButton>
        <TerminalButton onClick={() => controller?.sceneService.resetScene()}>
          [F9] RESET
        </TerminalButton>
      </div>
      <ol className="cue-list">
        {cueLabels.length === 0 ? (
          <li className="is-empty">Сценарные cue появятся после выбора</li>
        ) : (
          cueLabels.map((label, index) => (
            <li
              key={`${index}-${label}`}
              className={index === cueIndex ? 'is-active' : index < cueIndex ? 'is-past' : ''}
            >
              <TerminalButton onClick={() => controller?.sceneService.executeCue(index)}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                {label}
              </TerminalButton>
            </li>
          ))
        )}
      </ol>
    </section>
  );
}
