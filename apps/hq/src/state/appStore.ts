'use client';

import {
  createInitialScreenState,
  type screenIds,
  type ScreenId,
  type ScreenState,
} from '@gremuchaya/domain';
import { subscribeWithSelector } from 'zustand/middleware';
import { useStore } from 'zustand/react';
import { createStore } from 'zustand/vanilla';

import {
  createInitialRuntimeState,
  type RuntimeState,
  type RuntimeStatePort,
} from '@/application/runtimeState';

interface AppStore extends RuntimeState {
  readonly replaceRuntimeState: (nextState: RuntimeState) => void;
}

export const appStore = createStore<AppStore>()(
  subscribeWithSelector((set) => ({
    ...createInitialRuntimeState(createInitialScreens()),
    replaceRuntimeState: (nextState) => {
      set(nextState);
    },
  })),
);

export const runtimeStatePort: RuntimeStatePort = {
  getSnapshot: () => appStore.getState(),
  commit: (nextState) => {
    appStore.getState().replaceRuntimeState(nextState);
  },
};

export function useAppStore<Selection>(selector: (state: AppStore) => Selection): Selection {
  return useStore(appStore, selector);
}

function createInitialScreens(): Record<ScreenId, ScreenState> {
  const create = (screenId: ScreenId) => createInitialScreenState(screenId);
  return {
    'hwan-main': create('hwan-main'),
    'hwan-map': create('hwan-map'),
    'hwan-comms': create('hwan-comms'),
    'wall-center': create('wall-center'),
    'wall-left': create('wall-left'),
    'wall-right': create('wall-right'),
    'kirillov-desk': create('kirillov-desk'),
    'interrogation-video': create('interrogation-video'),
    'interrogation-audio': create('interrogation-audio'),
  } satisfies Record<(typeof screenIds)[number], ScreenState>;
}
