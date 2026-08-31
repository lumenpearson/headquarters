'use client';

import { TerminalSelect } from '@gremuchaya/ui/primitives';

import { useTranslate } from '@/application/localization/locale';
import type { MessageId } from '@/application/localization/messages';
import type { MaterialRendition } from '@/infrastructure/materials/materialLibrary';

/**
 * What the library answered for the rendition currently on screen.
 *
 * `pending` while the grant is in flight, `rendered` when the answer was a
 * distinct object, `original` when it was the stored object under the
 * rendition's name, `failed` when there was no answer at all.
 */
export type RenditionOutcome = 'pending' | 'rendered' | 'original' | 'failed';

/*
 * The honest half of the control lives in `rendition.outcome.original`'s
 * text, not in this table: every deployment in this repository presigns the
 * stored object for whatever variant it is asked for, so a menu that stayed
 * silent here would read as a quality change that never happened.
 */
const outcomeMessageIds: Readonly<Record<RenditionOutcome, MessageId>> = {
  pending: 'rendition.outcome.pending',
  rendered: 'rendition.outcome.rendered',
  original: 'rendition.outcome.original',
  failed: 'rendition.outcome.failed',
};

/**
 * The quality menu, driven by `GetPreviewGrant.variant` (R21, C25).
 *
 * One control, used by the file viewer and by the video transport bar, so the
 * two cannot come to disagree about what a variant name means or about how a
 * refusal reads. The entries are the ones the selected library named; picking
 * one is what puts that string on the next grant request.
 */
export function MaterialRenditionMenu({
  renditions,
  variant,
  onVariantChange,
  outcome,
  disabled = false,
  className,
}: {
  readonly renditions: readonly MaterialRendition[];
  readonly variant: string;
  readonly onVariantChange: (variant: string) => void;
  readonly outcome: RenditionOutcome;
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  const translate = useTranslate();
  if (renditions.length <= 1) {
    /*
     * A single-entry menu is not a choice. The loopback bridge has no variant
     * selector anywhere in `FileBridgeService`, so it says so in words rather
     * than offering a select that can only be reopened on the value it already
     * shows.
     */
    return (
      <span className={joinClassNames('material-rendition-menu__single', className)}>
        {translate('rendition.singleEntry')}
      </span>
    );
  }

  return (
    <div className={joinClassNames('material-rendition-menu', className)}>
      <TerminalSelect
        className="material-rendition-menu__select"
        value={variant}
        options={renditions.map((rendition) => ({
          value: rendition.variant,
          label: rendition.label,
        }))}
        onValueChange={onVariantChange}
        label={translate('rendition.qualityLabel')}
        disabled={disabled}
      />
      <span
        className="material-rendition-menu__outcome"
        data-outcome={outcome}
        role={outcome === 'failed' ? 'alert' : 'status'}
        aria-live="polite"
      >
        {translate(outcomeMessageIds[outcome])}
      </span>
    </div>
  );
}

function joinClassNames(...values: readonly (string | undefined)[]): string {
  return values.filter((value) => value !== undefined && value.length > 0).join(' ');
}
