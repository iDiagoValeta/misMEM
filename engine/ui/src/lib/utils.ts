import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Une clases condicionales y deja ganar a la última utilidad de Tailwind que toca la misma propiedad. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
