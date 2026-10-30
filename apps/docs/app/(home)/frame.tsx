import type { ReactNode } from 'react';

/**
 * A drawing's place on the landing until the commissioned art fills it (X6): a tinted frame with its concept set in
 * type, never stock art. `slot` names the drawing that replaces it; the frame is decoration, so readers skip it.
 */
export function Frame({ slot, dashed, children }: { slot: string; dashed?: boolean; children: ReactNode }) {
  return (
    <div
      aria-hidden
      data-slot={slot}
      className={`flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl bg-fd-accent p-6 ${
        dashed ? 'border-2 border-dashed border-fd-primary/50' : 'border border-fd-primary/15'
      }`}
    >
      <div className="font-mono text-sm leading-relaxed whitespace-pre text-fd-primary sm:text-base">
        {children}
      </div>
    </div>
  );
}
