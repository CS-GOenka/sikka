"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useTransition } from "react";

/**
 * Steps the selected week or month one period at a time, with the comparison
 * always following the selection: August sits against July, and stepping back
 * to March puts March against February. There is deliberately no way to pair
 * arbitrary periods - the comparison is never a second thing to choose.
 *
 * The offset lives in the URL rather than in component state because a period
 * outside the fetched span needs rows only the server can get. Wrapped in a
 * transition so the arrows stay live while those rows are on their way.
 */
export function PeriodStepper({
  paramKey,
  offset,
  label,
  canStepForward,
}: {
  /** "wo" or "mo" - which offset in the querystring this stepper owns. */
  paramKey: string;
  offset: number;
  label: string;
  canStepForward: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function href(by: number) {
    const next = new URLSearchParams(params.toString());
    const value = offset + by;
    if (value === 0) next.delete(paramKey);
    else next.set(paramKey, String(value));
    const query = next.toString();
    return query ? `/?${query}` : "/";
  }

  // Warm the periods on either side. Stepping is the one dashboard control
  // that cannot be answered from what the page already holds - the rows for
  // another month were never fetched - so the render it triggers is a full
  // server round trip. Asking for it while the reader is still looking at the
  // current period turns most of that wait into no wait at all.
  //
  // Both directions, because walking back through the months and then
  // forwards again is the ordinary way this gets used.
  useEffect(() => {
    router.prefetch(href(-1));
    if (canStepForward) router.prefetch(href(1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramKey, offset, canStepForward, params]);

  function step(by: number) {
    const query = href(by);
    startTransition(() => {
      // scroll:false so stepping doesn't throw the reader back to the top of
      // the page each time they walk backwards through the months.
      router.push(query, { scroll: false });
    });
  }

  return (
    <div className="flex items-center justify-center gap-1">
      <StepButton label="Previous period" onClick={() => step(-1)} disabled={false}>
        ‹
      </StepButton>
      <span
        aria-live="polite"
        className="min-w-[9.5rem] text-center text-[0.875rem] font-semibold tabular-nums text-[var(--sk-ink)]"
        style={{ opacity: pending ? 0.5 : 1 }}
      >
        {label}
      </span>
      <StepButton
        label="Next period"
        onClick={() => step(1)}
        disabled={!canStepForward}
      >
        ›
      </StepButton>
    </div>
  );
}

function StepButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex size-9 items-center justify-center rounded-full border border-[var(--sk-hair-strong)] bg-[var(--sk-surface)] text-lg leading-none text-[var(--sk-ink-2)] transition-colors active:bg-[var(--sk-plane)] disabled:border-[var(--sk-hair)] disabled:text-[var(--sk-hair-strong)]"
    >
      {children}
    </button>
  );
}
