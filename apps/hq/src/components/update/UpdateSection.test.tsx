// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppUpdatePort } from '@/application/update/appUpdatePort';
import { operationsStore } from '@/state/operationsStore';

import { UpdateSection } from './UpdateSection';

function createPort(overrides: Partial<AppUpdatePort> = {}): AppUpdatePort {
  return {
    available: () => true,
    checkForUpdate: vi.fn(),
    startDownload: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    install: vi.fn(),
    isAutostartEnabled: vi.fn().mockResolvedValue(false),
    setAutostart: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('UpdateSection', () => {
  beforeEach(() => {
    // Both startup switches back to their schema default (false), between
    // tests in this file that toggle them through the UI.
    operationsStore.getState().discardSettingsDraft();
  });

  it('renders update.unavailable and disables every control when no adapter exists', async () => {
    render(<UpdateSection port={null} />);

    expect(
      await screen.findByText('ОБНОВЛЕНИЕ ИЗНУТРИ ДОСТУПНО ТОЛЬКО В ДЕСКТОПНОЙ СБОРКЕ'),
    ).toBeTruthy();
    const check = screen.getByRole('button', { name: '[U] ПРОВЕРИТЬ ОБНОВЛЕНИЕ' });
    expect((check as HTMLButtonElement).disabled).toBe(true);
    for (const switchElement of screen.getAllByRole('switch')) {
      expect((switchElement as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('both startup switches default off', () => {
    render(<UpdateSection port={createPort()} />);

    const launchOnLogin = screen.getByRole('switch', { name: 'Автозапуск при входе' });
    const autoUpdate = screen.getByRole('switch', { name: 'Автообновление' });
    expect(launchOnLogin.getAttribute('aria-checked')).toBe('false');
    expect(autoUpdate.getAttribute('aria-checked')).toBe('false');
  });

  it('reconciles the autostart switch through the port, and reports honestly when it refuses', async () => {
    const setAutostart = vi.fn().mockRejectedValue(new Error('permission denied'));
    const isAutostartEnabled = vi.fn().mockResolvedValue(false);
    render(<UpdateSection port={createPort({ setAutostart, isAutostartEnabled })} />);

    fireEvent.click(screen.getByRole('switch', { name: 'Автозапуск при входе' }));

    await screen.findByText('ОШИБКА: permission denied');
    expect(setAutostart).toHaveBeenCalledWith(true);
    expect(isAutostartEnabled).toHaveBeenCalled();
    // The switch itself follows the operator's own intent (the setting), not
    // the port's refusal -- the honest report sits beside it instead.
    expect(
      screen.getByRole('switch', { name: 'Автозапуск при входе' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('drives the whole cycle: check, download with a percent, pause, resume, cancel back to idle, check again, ready, install', async () => {
    let progressCallback: ((received: number, total: number | null) => void) | undefined;
    let startDownloadCalls = 0;
    let resumeSettle: (() => void) | undefined;
    const port = createPort({
      checkForUpdate: vi.fn().mockResolvedValue({ version: '2.0.0', notes: 'Fixes things' }),
      startDownload: vi
        .fn()
        .mockImplementation(
          async (onProgress: (received: number, total: number | null) => void) => {
            startDownloadCalls += 1;
            progressCallback = onProgress;
            if (startDownloadCalls === 1) {
              onProgress(50, 100);
              // Deliberately never settles within this test: pause/resume/cancel
              // below must not need it to.
              return new Promise<void>(() => {});
            }
            // The second attempt completes cleanly, straight to ready.
            onProgress(100, 100);
          },
        ),
      pause: vi.fn().mockResolvedValue(undefined),
      // Mirrors the real adapter: the same progress stream keeps arriving
      // across a pause/resume cycle rather than resume() taking a new callback.
      resume: vi.fn().mockImplementation(async () => {
        progressCallback?.(70, 100);
        return new Promise<void>((resolve) => {
          resumeSettle = resolve;
        });
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
      install: vi.fn().mockResolvedValue(undefined),
    });

    render(<UpdateSection port={port} />);

    fireEvent.click(screen.getByRole('button', { name: '[U] ПРОВЕРИТЬ ОБНОВЛЕНИЕ' }));
    await screen.findByText('ОБНОВЛЕНИЕ ДОСТУПНО');
    expect(screen.getByText('2.0.0')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '[D] СКАЧАТЬ' }));
    await screen.findByText('СКАЧАНО 50%');

    fireEvent.click(screen.getByRole('button', { name: '[P] ПАУЗА' }));
    await screen.findByText('СКАЧИВАНИЕ ПРИОСТАНОВЛЕНО');
    expect(screen.getByText('СКАЧАНО 50%')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '[R] ПРОДОЛЖИТЬ' }));
    await screen.findByText('СКАЧАНО 70%');

    fireEvent.click(screen.getByRole('button', { name: '[C] ОТМЕНИТЬ' }));
    // Cancel folds back to idle, not to available: a fresh check is required
    // before another download can start (AppUpdateService's own contract).
    await screen.findByText('ПРОВЕРКА НЕ ВЫПОЛНЯЛАСЬ');
    expect(port.cancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '[D] СКАЧАТЬ' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '[U] ПРОВЕРИТЬ ОБНОВЛЕНИЕ' }));
    await screen.findByText('ОБНОВЛЕНИЕ ДОСТУПНО');

    fireEvent.click(screen.getByRole('button', { name: '[D] СКАЧАТЬ' }));
    await screen.findByText('ГОТОВО К УСТАНОВКЕ');
    expect(startDownloadCalls).toBe(2);

    fireEvent.click(screen.getByRole('button', { name: '[I] УСТАНОВИТЬ И ПЕРЕЗАПУСТИТЬ' }));
    await screen.findByText('УСТАНОВКА…');
    expect(port.install).toHaveBeenCalledTimes(1);

    resumeSettle?.();
  });
});
