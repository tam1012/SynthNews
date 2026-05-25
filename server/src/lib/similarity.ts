/**
 * Near-duplicate clustering for newly-fetched articles.
 *
 * Approach: character-bigram Jaccard similarity on title + excerpt (cross-language friendly,
 * works for Vietnamese/Chinese/Japanese/English). Includes a small bonus when image URLs
 * match (wire-service photo == strong duplicate signal).
 *
 * Novelty check: if a candidate is similar to a leader but its content adds significant new
 * keywords (>= NOVELTY_THRESHOLD), it is treated as an independent follow-up story rather
 * than a duplicate, so updates are not lost.
 */

export const SIMILARITY_THRESHOLD = 0.60;
export const NOVELTY_THRESHOLD = 0.30;
export const IMAGE_MATCH_BONUS = 0.15;
export const CLUSTER_WINDOW_HOURS = 6;
// Minimum token count for word-Jaccard to be meaningful (CJK falls back to bigrams).
const MIN_TOKENS_FOR_WORD_JACCARD = 4;

const STOPWORDS_RE = /\s+/g;

function normalize(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(STOPWORDS_RE, ' ')
    .trim();
}

/**
 * Build a set of character bigrams from text. Works across scripts (Latin, CJK, etc.).
 * For very short text (<2 chars) returns empty set so caller can skip comparison.
 */
export function charBigrams(text: string): Set<string> {
  const norm = normalize(text);
  const out = new Set<string>();
  if (norm.length < 2) return out;
  // Tokenize by whitespace, then bigram each token to avoid spanning word boundaries.
  for (const token of norm.split(' ')) {
    if (token.length < 2) {
      if (token.length === 1) out.add(token);
      continue;
    }
    for (let i = 0; i < token.length - 1; i++) {
      out.add(token.slice(i, i + 2));
    }
  }
  return out;
}

/**
 * Word-token set (length >= 2). Effective for space-separated languages
 * (Vietnamese, English, Indonesian); returns small set for CJK so caller can fall back
 * to char-bigram comparison instead.
 */
export function wordTokens(text: string): Set<string> {
  const norm = normalize(text);
  const out = new Set<string>();
  if (!norm) return out;
  for (const token of norm.split(' ')) {
    if (token.length >= 2) out.add(token);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * Top-N word-tokens (length >= 3) by frequency from text. Used for novelty detection:
 * if the candidate introduces >= NOVELTY_THRESHOLD fraction of new tokens that did not
 * appear in the leader, treat it as a follow-up story rather than a duplicate.
 */
export function topKeywords(text: string, n = 30): Set<string> {
  const norm = normalize(text);
  if (!norm) return new Set();
  const counts = new Map<string, number>();
  for (const token of norm.split(' ')) {
    if (token.length < 3) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  return new Set(sorted.map(([t]) => t));
}

export interface SimilarityCandidate {
  id: string;
  title: string;
  excerpt: string;
  imageUrl: string | null;
}

export interface SimilarityScore {
  score: number;
  titleScore: number;
  excerptScore: number;
  imageMatch: boolean;
}

/**
 * Compute similarity between two articles. Score is max(title, excerpt) jaccard + optional
 * image bonus, capped at 1.0.
 */
function bestJaccard(textA: string, textB: string): number {
  const tokensA = wordTokens(textA);
  const tokensB = wordTokens(textB);
  const wordScore = (tokensA.size >= MIN_TOKENS_FOR_WORD_JACCARD &&
                     tokensB.size >= MIN_TOKENS_FOR_WORD_JACCARD)
    ? jaccard(tokensA, tokensB)
    : 0;
  const bigramScore = jaccard(charBigrams(textA), charBigrams(textB));
  return Math.max(wordScore, bigramScore);
}

export function computeSimilarity(
  a: SimilarityCandidate,
  b: SimilarityCandidate
): SimilarityScore {
  const titleScore = bestJaccard(a.title, b.title);
  const excerptScore = bestJaccard(a.excerpt, b.excerpt);
  const imageMatch = Boolean(a.imageUrl && b.imageUrl && a.imageUrl === b.imageUrl);
  // Combine: title carries more semantic weight than excerpt; weight 0.6 / 0.4 then take
  // max with each individual score so a strong single signal can still cross the threshold.
  const combined = titleScore * 0.6 + excerptScore * 0.4;
  const base = Math.max(titleScore, excerptScore, combined);
  const score = Math.min(1, base + (imageMatch ? IMAGE_MATCH_BONUS : 0));
  return { score, titleScore, excerptScore, imageMatch };
}

/**
 * Novelty = fraction of candidate's top keywords that are NOT in leader's top keywords.
 * High novelty (>= NOVELTY_THRESHOLD) => candidate adds new info => do not cluster.
 */
export function computeNovelty(candidate: string, leader: string): number {
  const candidateKw = topKeywords(candidate);
  if (candidateKw.size === 0) return 0;
  const leaderKw = topKeywords(leader);
  let newCount = 0;
  for (const kw of candidateKw) {
    if (!leaderKw.has(kw)) newCount++;
  }
  return newCount / candidateKw.size;
}

/**
 * A short signature stored for debugging. Picks the first 5 keywords joined by '|'.
 */
export function buildClusterSignature(title: string, excerpt: string): string {
  const kw = topKeywords(`${title} ${excerpt}`, 5);
  return [...kw].join('|');
}
