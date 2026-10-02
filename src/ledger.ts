import type { Draft, PersistedState, Protest, Publication, PublishedRanking, RaceEntry } from './types';

export const STORAGE_KEY = 'regatta-control-v2';
export const LEGACY_STORAGE_KEY = 'regatta-control-v1';
export const LEDGER_VERSION = 2 as const;

/** Build a fresh v2 ledger (used when no stored state exists). */
export function createInitialState(): PersistedState {
  return {
    version: LEDGER_VERSION,
    revision: 1,
    races: [],
    entries: [],
    protests: [],
    timeline: [],
    publications: [],
    drafts: {}
  };
}

/**
 * Migrate any stored blob into a v2 ledger.
 * v1 had races/entries/protests/timeline but no revision/ledger fields;
 * the original races, results and protests are preserved verbatim.
 */
export function migrate(raw: unknown): PersistedState {
  if (raw && typeof raw === 'object' && (raw as PersistedState).version === LEDGER_VERSION) {
    return raw as PersistedState;
  }
  const legacy = (raw ?? {}) as Partial<PersistedState>;
  return {
    version: LEDGER_VERSION,
    revision: 1,
    races: Array.isArray(legacy.races) ? legacy.races : [],
    entries: Array.isArray(legacy.entries) ? legacy.entries : [],
    protests: Array.isArray(legacy.protests) ? legacy.protests : [],
    timeline: Array.isArray(legacy.timeline) ? legacy.timeline : [],
    publications: [],
    drafts: {}
  };
}

/** Load the ledger from localStorage, migrating a legacy v1 blob if present. */
export function loadPersisted(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migrate(JSON.parse(raw));
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const migrated = migrate(JSON.parse(legacy));
      savePersisted(migrated);
      return migrated;
    }
  } catch {
    /* fall through to empty state */
  }
  return createInitialState();
}

/** Persist the ledger to localStorage. */
export function savePersisted(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage may be unavailable; ledger stays in memory */
  }
}

/** Read the current storage revision without parsing the whole ledger. */
export function getStorageRevision(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return typeof parsed.revision === 'number' ? parsed.revision : 0;
  } catch {
    return 0;
  }
}

/** True when any protest is still open (submitted / under review). */
export function hasOpenProtests(protests: Protest[]): boolean {
  return protests.some((p) => p.status === 'submitted' || p.status === 'reviewing');
}

/** True when any penalty result is awaiting review/publish. */
export function hasPendingReviewPenalties(entries: RaceEntry[]): boolean {
  return entries.some((e) => e.resultStatus === 'corrected');
}

/** Recalculate the leaderboard rankings from the current entries. */
export function computeRankings(entries: RaceEntry[]): PublishedRanking[] {
  return [...entries]
    .sort((a, b) => a.elapsedSeconds + a.penaltySeconds - (b.elapsedSeconds + b.penaltySeconds))
    .map((entry, index) => ({
      rank: index + 1,
      entryId: entry.id,
      boat: entry.boat,
      sailNo: entry.sailNo,
      elapsedSeconds: entry.elapsedSeconds,
      penaltySeconds: entry.penaltySeconds,
      totalSeconds: entry.elapsedSeconds + entry.penaltySeconds
    }));
}

/** Build a new publication snapshot from the current ledger state. */
export function buildPublication(state: PersistedState, publishedBy: string, note: string): Publication {
  return {
    id: crypto.randomUUID(),
    revision: state.revision,
    publishedAt: new Date().toISOString(),
    publishedBy,
    note,
    status: 'active',
    rankings: computeRankings(state.entries)
  };
}

/** The currently active publication, if any. */
export function getActivePublication(publications: Publication[]): Publication | undefined {
  return publications.find((p) => p.status === 'active');
}

/** Load a saved draft by key. */
export function loadDraft(key: string): Draft | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const state = JSON.parse(raw) as PersistedState;
    return state.drafts?.[key];
  } catch {
    return undefined;
  }
}
