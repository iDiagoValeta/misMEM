import { useEffect, useState } from "react";

export interface Loaded<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
}

/** Carga `load()` cada vez que cambian `deps`; una respuesta vieja no pisa a una nueva. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ data: undefined, error: undefined, loading: true });
  useEffect(() => {
    let current = true;
    setState((prev) => ({ ...prev, loading: true, error: undefined }));
    load().then(
      (data) => current && setState({ data, error: undefined, loading: false }),
      (err: unknown) =>
        current && setState({ data: undefined, error: err instanceof Error ? err.message : String(err), loading: false }),
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
