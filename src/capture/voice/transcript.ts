import type { SpeechResultsLike } from "./environment";

/**
 * Keeps the dictated text in memory only. A recognizer reports its whole result list on every event, so the list
 * replaces the current segment, and a restarted recognizer starts a new segment.
 */
export class TranscriptBuffer {
  #segments: string[] = [];
  #current = "";

  update(results: SpeechResultsLike): void {
    const parts: string[] = [];
    for (let index = 0; index < results.length; index++) {
      const text = results[index]?.[0]?.transcript?.trim();
      if (text) parts.push(text);
    }
    this.#current = parts.join(" ");
  }

  /** Closes the current segment, for example when the browser ends a long session and it is restarted. */
  commit(): void {
    if (this.#current) this.#segments.push(this.#current);
    this.#current = "";
  }

  text(): string {
    return [...this.#segments, this.#current].filter(Boolean).join(" ").replace(/\s+/gu, " ").trim();
  }

  clear(): void {
    this.#segments = [];
    this.#current = "";
  }
}
