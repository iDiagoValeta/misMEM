// Owns what the three layer views of the detail panel share: ink tint, truncation, section title and the loading and failure states.
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "../lib/errors";
import { inkPercent } from "../lib/ink";

export const tint = (salience: number): string =>
  `color-mix(in oklab, var(--color-ink) ${inkPercent(salience)}%, var(--color-ink-muted))`;

export const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function SectionTitle({ children }: { children: string }) {
  return <h3 className="mb-1.5 text-[11px] uppercase tracking-wider text-ink-muted">{children}</h3>;
}

export function DetailLoading({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-2">
      <span role="status" className="sr-only">
        {label}
      </span>
      <Skeleton className="h-5 w-24 bg-field" />
      <Skeleton className="h-20 w-full bg-field" />
      <Skeleton className="h-28 w-full bg-field" />
    </div>
  );
}

export function DetailFailure({ what, error }: { what: string; error: unknown }) {
  return (
    <p role="alert" className="rounded-md bg-field px-2 py-2 text-sm text-danger">
      No se pudo cargar {what}: {errorMessage(error)}
    </p>
  );
}
