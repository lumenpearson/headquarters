// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { forwardRef, useImperativeHandle, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { LocalMaterialPlayer } from './LocalMaterialPlayer';
import type { MaterialSubtitleTrack } from './materialSubtitleTracks';

/*
 * Same reasoning as `MaterialRenditionMenu.test.tsx`: vidstack loads a real
 * provider against a real media element, which jsdom does not implement.
 * `Track` renders nothing at all in the real library (`declare function
 * Track(...): null`), so this stub renders a plain marker instead -- the
 * point under test is that `LocalMaterialPlayer` hands it the right props,
 * not how vidstack itself renders a track.
 */
const fakeTextTrack = { kind: 'subtitles', mode: 'showing' };

vi.mock('@vidstack/react', async () => {
  const { createElement } = await import('react');
  return {
    MediaProvider: ({ children }: { readonly children?: ReactNode }) =>
      createElement('div', null, children),
    Track: (props: {
      readonly src?: string;
      readonly label?: string;
      readonly lang?: string;
      readonly default?: boolean;
    }) =>
      createElement('div', {
        'data-testid': 'subtitle-track',
        'data-src': props.src,
        'data-label': props.label,
        'data-lang': props.lang,
        'data-default': props.default ?? false,
      }),
    MediaPlayer: forwardRef(function MediaPlayerStub(
      props: { readonly children?: ReactNode; readonly 'aria-label'?: string },
      ref: unknown,
    ) {
      useImperativeHandle(
        ref as never,
        () => ({
          paused: true,
          duration: 0,
          muted: false,
          currentTime: 0,
          textTracks: { getByKind: () => [fakeTextTrack] },
          play: () => Promise.resolve(),
          pause: () => Promise.resolve(),
          enterFullscreen: () => Promise.resolve(),
        }),
        [],
      );
      return createElement('div', { 'aria-label': props['aria-label'] }, props.children);
    }),
  };
});

const tracks: readonly MaterialSubtitleTrack[] = [
  { id: 'a', url: 'blob:english', label: 'EN', srcLang: 'en', default: true },
  { id: 'b', url: 'blob:russian', label: 'RU', srcLang: 'ru', default: false },
];

describe('LocalMaterialPlayer subtitles', () => {
  it('renders one Track per resolved subtitle track', () => {
    render(<LocalMaterialPlayer sourceUrl="blob:video" title="clip.mp4" tracks={tracks} />);

    const rendered = screen.getAllByTestId('subtitle-track');
    expect(rendered).toHaveLength(2);
    expect(rendered[0]?.getAttribute('data-src')).toBe('blob:english');
    expect(rendered[0]?.getAttribute('data-lang')).toBe('en');
    expect(rendered[0]?.getAttribute('data-default')).toBe('true');
    expect(rendered[1]?.getAttribute('data-src')).toBe('blob:russian');
  });

  it('shows no caption toggle and no track for a material with none', () => {
    render(<LocalMaterialPlayer sourceUrl="blob:video" title="clip.mp4" />);

    expect(screen.queryAllByTestId('subtitle-track')).toHaveLength(0);
    expect(screen.queryByText(/\[CC\]/u)).toBeNull();
  });

  it('toggles every subtitle/caption track off, then back on', () => {
    render(<LocalMaterialPlayer sourceUrl="blob:video" title="clip.mp4" tracks={tracks} />);

    const toggle = screen.getByText('[CC] SUBS ON');
    fireEvent.click(toggle);
    expect(fakeTextTrack.mode).toBe('disabled');
    expect(screen.getByText('[CC] SUBS OFF')).toBeTruthy();

    fireEvent.click(screen.getByText('[CC] SUBS OFF'));
    expect(fakeTextTrack.mode).toBe('showing');
  });
});
