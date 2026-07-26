// Public types for the translation service. The on-disk dictionary
// shape is the authoritative cache format — see plans/done/feat-translation-service.md.

export interface TranslateRequest {
  /** Dictionary namespace; also the cache filename. */
  readonly namespace: string;
  /** BCP-47 short code, e.g. `ja`, `pt-BR`. */
  readonly targetLanguage: string;
  /** English source sentences in the order the caller wants them returned. */
  readonly sentences: readonly string[];
}

export interface TranslateResponse {
  readonly translations: readonly string[];
}

export interface DictionaryFile {
  readonly sentences: Record<string, Record<string, string>>;
}

export interface TranslateBatchInput {
  readonly targetLanguage: string;
  readonly sentences: readonly string[];
}

export type TranslateBatchFn = (input: TranslateBatchInput) => Promise<string[]>;

export interface TranslationServiceDeps {
  readonly translateBatch: TranslateBatchFn;
  readonly workspaceRoot?: string;
}

export interface TranslationService {
  /** Accepts an unvalidated payload — `validateRequest` narrows it. The HTTP
   *  route can therefore pass `req.body` straight through. */
  readonly translate: (req: unknown) => Promise<TranslateResponse>;
}
