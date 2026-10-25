import type { Selection } from "../App";

interface Props {
  scope: string | undefined;
  onSelect: (selection: Selection) => void;
}

/**
 * Sustituto mínimo del grafo mientras se rehace en 2D con react-force-graph-2d. Conserva
 * las props que ya pasa App para no tocarla; el 3D se retiró con three.js.
 */
export default function GraphView(_props: Props) {
  return <p>Grafo en construcción</p>;
}
