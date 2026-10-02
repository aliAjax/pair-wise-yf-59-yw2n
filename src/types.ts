export type RaceStatus = 'scheduled' | 'running' | 'finished';
export type ProtestStatus = 'submitted' | 'reviewing' | 'resolved' | 'rejected';
export type ResultStatus = 'provisional' | 'corrected' | 'official';
export type PublicationStatus = 'active' | 'superseded' | 'rolled-back';

/** A single ranked row captured in a published leaderboard snapshot. */
export interface PublishedRanking {
  rank: number;
  entryId: string;
  boat: string;
  sailNo: string;
  elapsedSeconds: number;
  penaltySeconds: number;
  totalSeconds: number;
}

/** An immutable record in the publish ledger. */
export interface Publication {
  id: string;
  /** Data revision this snapshot was published from. */
  revision: number;
  publishedAt: string;
  publishedBy: string;
  note: string;
  status: PublicationStatus;
  rankings: PublishedRanking[];
}

/** An unpublished editing draft that can be recovered on reopen. */
export interface Draft {
  key: string;
  payload: Record<string, unknown>;
  savedAt: string;
}

/** The full shape persisted to localStorage (v2 ledger). */
export interface PersistedState {
  version: 2;
  /** Monotonically increasing data revision; bumped on every shared mutation. */
  revision: number;
  races: Race[];
  entries: RaceEntry[];
  protests: Protest[];
  timeline: TimelineEvent[];
  publications: Publication[];
  drafts: Record<string, Draft>;
}

export interface Race {
  id: string;
  name: string;
  fleet: string;
  course: string;
  startsAt: string;
  status: RaceStatus;
}

export interface RaceEntry {
  id: string;
  boat: string;
  sailNo: string;
  skipper: string;
  elapsedSeconds: number;
  penaltySeconds: number;
  resultStatus: ResultStatus;
  note: string;
}

export interface Protest {
  id: string;
  raceId: string;
  entryId: string;
  reason: string;
  rule: string;
  status: ProtestStatus;
  decision: string;
  createdAt: string;
}

export interface TimelineEvent {
  id: string;
  time: string;
  type: 'race' | 'result' | 'protest' | 'system';
  message: string;
}
