import { useEffect, useState } from "react";

/** Keeps the last usable wallboard payload visible while its replacement loads or retries. */
export function useRetainedValue<T>(value: T | null | undefined) {
  const [retainedValue, setRetainedValue] = useState<T | undefined>(value ?? undefined);

  useEffect(() => {
    if (value !== null && value !== undefined) setRetainedValue(value);
  }, [value]);

  return value ?? retainedValue;
}
