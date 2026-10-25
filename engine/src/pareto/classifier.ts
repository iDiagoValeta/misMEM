/**
 * Clasificador Pareto inspirado en PAMPAr-Coder.
 *
 * Asigna a cada episodio un score de importancia [0,1] y un nivel (L0..L3).
 * Heurístico, sin LLM, sin DB. Pensado para correr antes del LLM costoso.
 *
 * Scoring:
 *   importance = 0.35*density + 0.30*novelty + 0.25*loss_proxy + 0.10*length_norm
 *
 * Niveles:
 *   L0  importance < 0.30   → ruido, candidato a forget inmediato
 *   L1  importance ≥ 0.30   → consolidable (LLM)
 *   L2  importance ≥ 0.60   → alta prioridad
 *   L3  importance ≥ 0.85   → semilla de trait (crystallize candidate)
 */
import { contentTerms } from "../terms.js";

/** Palabras con contenido desde las que un texto corto deja de ser muletilla. */
const MIN_FACT_TERMS = 3;

export interface ParetoScores {
  density: number;
  novelty: number;
  loss_proxy: number;
  length_norm: number;
}

export interface ParetoResult {
  importance: number;
  level: 0 | 1 | 2 | 3;
  scores: ParetoScores;
}

export interface ClassifyOptions {
  /** Loss del modelo si está disponible, en [0, 5+]. Default 0. */
  lossHint?: number;
  /** Lista de textos vecinos (mismo scope/recientes) para calcular novedad. */
  neighbors?: string[];
}

const PAT_CODE = [
  /\bclass\s+\w+/g,
  /\b(def|function|fn|func)\s+\w+\s*\(/g,
  /@\w+/g,
  /\b(try|except|catch|throw|raise)\b/g,
  /:\s*\w+\s*[,)=]|->\s*\w+/g,
  /\[.*\bfor\b.*\bin\b.*\]/g,
  /\b(async|await|yield)\b/g,
  /\b(import|from|require|use)\b/g,
];

const PAT_DECISION = [
  /\b(decisi[oó]n|decision|chose|elegimos|bug|bugfix|fixed|fixé|root cause|tradeoff|aprend[ií])\b/gi,
  /\b(why|porque|because|evitar|avoid|never|nunca|always|siempre)\b/gi,
];

// Una preferencia cabe en pocas palabras y no trae patrones técnicos: sin esto
// "prefiero Rust para el backend" quedaba en L0 y se descartaba antes del LLM.
const PAT_PREFERENCE = [
  /\b(prefiero|prefer[ií]|prefer|me gusta|odio|detesto|dej[eé] de|en vez de|instead of)\b/gi,
  /\b(uso|usamos|us[eé]|using|me quedo con|elijo|voy con|mejor que|worse than|better than)\b/gi,
];

/**
 * Densidad por línea de patrones de código, decisión y preferencia.
 * Más patrones avanzados → más conceptos → más valioso.
 */
function computeDensity(text: string): number {
  const lines = text.split(/\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return 0;

  let hits = 0;
  for (const p of PAT_CODE) {
    const m = text.match(p);
    if (m) hits += m.length;
  }
  for (const p of PAT_DECISION) {
    const m = text.match(p);
    if (m) hits += m.length;
  }
  for (const p of PAT_PREFERENCE) {
    const m = text.match(p);
    if (m) hits += m.length;
  }
  // Normalizar: 8+ hits / 10 líneas = densidad máxima
  return Math.min(1, hits / Math.max(1, lines.length) / 0.8);
}

/**
 * Novedad por overlap de n-gramas (3-grams de palabras).
 * Sin embeddings → rápido y offline.
 */
function computeNovelty(text: string, neighbors: string[]): number {
  if (neighbors.length === 0) return 1;
  const ngrams = (s: string): Set<string> => {
    const words = s.toLowerCase().match(/\w+/g) ?? [];
    const out = new Set<string>();
    for (let i = 0; i < words.length - 2; i++) {
      out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }
    return out;
  };

  const target = ngrams(text);
  if (target.size === 0) return 1;

  let maxOverlap = 0;
  for (const n of neighbors) {
    const other = ngrams(n);
    if (other.size === 0) continue;
    let common = 0;
    for (const g of target) if (other.has(g)) common++;
    const overlap = common / target.size;
    if (overlap > maxOverlap) maxOverlap = overlap;
  }
  return 1 - maxOverlap;
}

function computeLengthNorm(text: string): number {
  // 500+ chars = máximo. Penaliza fragmentos triviales.
  return Math.min(1, text.length / 500);
}

function computeLossProxy(lossHint: number): number {
  // Loss típica: 0–5+. Normalizar a [0,1]. >5 = saturar.
  if (!Number.isFinite(lossHint) || lossHint <= 0) return 0;
  return Math.min(1, lossHint / 5);
}

function levelOf(importance: number): 0 | 1 | 2 | 3 {
  if (importance < 0.3) return 0;
  if (importance < 0.6) return 1;
  if (importance < 0.85) return 2;
  return 3;
}

export function classify(text: string, opts: ClassifyOptions = {}): ParetoResult {
  if (!text.trim()) {
    return {
      importance: 0,
      level: 0,
      scores: { density: 0, novelty: 0, loss_proxy: 0, length_norm: 0 },
    };
  }

  const density = computeDensity(text);
  const novelty = computeNovelty(text, opts.neighbors ?? []);
  const loss_proxy = computeLossProxy(opts.lossHint ?? 0);
  const length_norm = computeLengthNorm(text);

  // Trivial: muy corto y sin densidad → L0 directo (evita inflado por novelty=1).
  // Pero un hecho corto ya es un dato ("el deploy tarda 40 minutos", "usar pnpm, no
  // npm"): ese va al LLM, que mandarlo cuesta casi nada y descartarlo acá lo borraba
  // sin que nadie lo leyera.
  // Un número suelto no es un hecho por sí mismo: "42", "2026" u "ok 2" son ruido como
  // "dale". Sólo cuenta si lo acompaña una palabra sin dígitos que diga de qué es
  // ("Node 24", "puerto 5000"). Por lo mismo, las tres palabras se cuentan sin números:
  // "1 2 3" no es un hecho.
  const hasFigure = /\p{N}/u.test(text);
  const namedTerms = [...contentTerms(text)].filter((t) => !/\p{N}/u.test(t)).length;

  if (
    text.trim().length < 40 &&
    density === 0 &&
    loss_proxy === 0 &&
    namedTerms < MIN_FACT_TERMS &&
    !(hasFigure && namedTerms > 0)
  ) {
    return {
      importance: 0,
      level: 0,
      scores: { density, novelty, loss_proxy, length_norm },
    };
  }

  const importance = Math.min(
    1,
    Math.round(
      (0.35 * density + 0.30 * novelty + 0.25 * loss_proxy + 0.10 * length_norm) * 10000,
    ) / 10000,
  );

  return {
    importance,
    level: levelOf(importance),
    scores: { density, novelty, loss_proxy, length_norm },
  };
}
