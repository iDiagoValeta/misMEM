import type { EpisodeItem, Layer } from "@/api";

/**
 * El episodio lleva su texto en la selección porque no hay endpoint de detalle por id:
 * el snapshot de la fila es lo único que lo tiene. Las demás capas se piden por id.
 */
export type Selection = { layer: Layer; id: string; episode?: EpisodeItem };
