export type RaceStatus = 'scheduled' | 'running' | 'finished';
export type ProtestStatus = 'submitted' | 'reviewing' | 'resolved' | 'rejected';
export type ResultStatus = 'provisional' | 'corrected' | 'official';

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

/** 某一发布版本中的一行名次快照 */
export interface Standing {
  rank: number;
  entryId: string;
  boat: string;
  sailNo: string;
  skipper: string;
  elapsedSeconds: number;
  penaltySeconds: number;
  totalSeconds: number;
}

export type PublicationStatus = 'active' | 'superseded' | 'invalidated';

/** 一次正式成绩发布，旧版本永久保留可查 */
export interface Publication {
  id: string;
  version: number;
  raceId: string;
  publishedAt: string;
  /** 计算名次所依据的账本修订号 */
  basisRevision: number;
  standings: Standing[];
  status: PublicationStatus;
  /** 发布原因 / 失效原因 */
  note: string;
}

/** 发布账：所有标签页共享的唯一事实来源 */
export interface LedgerDoc {
  revision: number;
  savedAt: string;
  races: Race[];
  entries: RaceEntry[];
  protests: Protest[];
  timeline: TimelineEvent[];
  publications: Publication[];
}

export interface ResultDraft {
  id: string;
  elapsedSeconds: number;
  penaltySeconds: number;
  note: string;
}

export interface ProtestDraft {
  entryId: string;
  reason: string;
  rule: string;
}
