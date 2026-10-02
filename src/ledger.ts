import { z } from 'zod';
import { computeStandings, PublishBlockedError, StaleActionError } from './domain';
import type { LedgerDoc, ProtestDraft, ResultDraft } from './types';

export const LEDGER_KEY = 'regatta-ledger-v2';
const BACKUP_KEY = `${LEDGER_KEY}.backup`;
const LEGACY_KEY = 'regatta-control-v1';
const LOCK_NAME = 'regatta-ledger-commit';

const raceSchema = z.object({
  id: z.string(),
  name: z.string(),
  fleet: z.string(),
  course: z.string(),
  startsAt: z.string(),
  status: z.enum(['scheduled', 'running', 'finished'])
});
const entrySchema = z.object({
  id: z.string(),
  boat: z.string(),
  sailNo: z.string(),
  skipper: z.string(),
  elapsedSeconds: z.number(),
  penaltySeconds: z.number(),
  resultStatus: z.enum(['provisional', 'corrected', 'official']),
  note: z.string()
});
const protestSchema = z.object({
  id: z.string(),
  raceId: z.string(),
  entryId: z.string(),
  reason: z.string(),
  rule: z.string(),
  status: z.enum(['submitted', 'reviewing', 'resolved', 'rejected']),
  decision: z.string(),
  createdAt: z.string()
});
const timelineSchema = z.object({
  id: z.string(),
  time: z.string(),
  type: z.enum(['race', 'result', 'protest', 'system']),
  message: z.string()
});
const standingSchema = z.object({
  rank: z.number(),
  entryId: z.string(),
  boat: z.string(),
  sailNo: z.string(),
  skipper: z.string(),
  elapsedSeconds: z.number(),
  penaltySeconds: z.number(),
  totalSeconds: z.number()
});
const publicationSchema = z.object({
  id: z.string(),
  version: z.number(),
  raceId: z.string(),
  publishedAt: z.string(),
  basisRevision: z.number(),
  standings: z.array(standingSchema),
  status: z.enum(['active', 'superseded', 'invalidated']),
  note: z.string()
});
const ledgerSchema = z.object({
  revision: z.number(),
  savedAt: z.string(),
  races: z.array(raceSchema),
  entries: z.array(entrySchema),
  protests: z.array(protestSchema),
  timeline: z.array(timelineSchema),
  publications: z.array(publicationSchema)
});
/** 旧版本数据宽松校验：缺字段给空数组，保证原有比赛/成绩/抗议尽量保留 */
const legacySchema = z.object({
  races: z.array(raceSchema).catch([]),
  entries: z.array(entrySchema).catch([]),
  protests: z.array(protestSchema).catch([]),
  timeline: z.array(timelineSchema).catch([])
});

export function seedDoc(): LedgerDoc {
  const now = new Date();
  const entries: LedgerDoc['entries'] = [
    { id: 'entry-1', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟', elapsedSeconds: 3168, penaltySeconds: 0, resultStatus: 'provisional', note: '' },
    { id: 'entry-2', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿', elapsedSeconds: 3194, penaltySeconds: 30, resultStatus: 'provisional', note: '标记争议' },
    { id: 'entry-3', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄', elapsedSeconds: 3210, penaltySeconds: 0, resultStatus: 'official', note: '' }
  ];
  return {
    revision: 1,
    savedAt: now.toISOString(),
    races: [
      { id: 'race-1', name: '海湾长距离赛 第1轮', fleet: '统一级', course: 'W2 / 东北风 12节', startsAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(), status: 'scheduled' }
    ],
    entries,
    protests: [
      { id: 'protest-1', raceId: 'race-1', entryId: 'entry-2', reason: '起航后发生舷侧接触', rule: 'RRS 14', status: 'reviewing', decision: '', createdAt: now.toISOString() }
    ],
    timeline: [
      { id: 'event-1', time: now.toISOString(), type: 'race', message: '航线 W2 已发布' },
      { id: 'event-2', time: new Date(now.getTime() + 2000).toISOString(), type: 'protest', message: '远岚号抗议进入复核' }
    ],
    publications: [
      {
        id: crypto.randomUUID(),
        version: 1,
        raceId: 'race-1',
        publishedAt: now.toISOString(),
        basisRevision: 1,
        standings: computeStandings(entries),
        status: 'active',
        note: '初始发布'
      }
    ]
  };
}

/** 旧数据升级：保留原有比赛、成绩、抗议，已含正式成绩时补建 v1 发布版本 */
export function migrateLegacy(raw: unknown): LedgerDoc {
  const legacy = legacySchema.parse(raw);
  const now = new Date().toISOString();
  const doc: LedgerDoc = {
    revision: 1,
    savedAt: now,
    races: legacy.races,
    entries: legacy.entries,
    protests: legacy.protests,
    timeline: [
      { id: crypto.randomUUID(), time: now, type: 'system', message: '数据已从旧版本升级，原有比赛、成绩和抗议已保留' },
      ...legacy.timeline
    ],
    publications: []
  };
  if (legacy.entries.length > 0 && legacy.entries.some((entry) => entry.resultStatus === 'official')) {
    doc.publications = [
      {
        id: crypto.randomUUID(),
        version: 1,
        raceId: legacy.races[0]?.id ?? 'race-1',
        publishedAt: now,
        basisRevision: 1,
        standings: computeStandings(legacy.entries),
        status: 'active',
        note: '旧数据迁移生成'
      }
    ];
  }
  return doc;
}

function tryRead(key: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const text = localStorage.getItem(key);
    if (text == null) return { ok: true, value: undefined };
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** 写入账本；主记录写成功后镜像到备份，主记录损坏时可恢复同一可用版本 */
function persistDoc(doc: LedgerDoc): void {
  const text = JSON.stringify(doc);
  localStorage.setItem(LEDGER_KEY, text);
  try {
    localStorage.setItem(BACKUP_KEY, text);
  } catch {
    /* 备份失败不阻断主流程 */
  }
}

function stashCorrupt(raw: unknown): void {
  try {
    localStorage.setItem(`${LEDGER_KEY}.corrupt.${Date.now()}`, JSON.stringify(raw) ?? 'unparseable');
  } catch {
    /* 仅尽力保留现场 */
  }
}

export interface LoadOutcome {
  doc: LedgerDoc;
  notice?: string;
}

export function loadLedger(): LoadOutcome {
  const main = tryRead(LEDGER_KEY);
  if (main.ok && main.value !== undefined) {
    const parsed = ledgerSchema.safeParse(main.value);
    if (parsed.success) return { doc: parsed.data };
  }
  if (main.ok && main.value === undefined) {
    const legacy = tryRead(LEGACY_KEY);
    if (legacy.ok && legacy.value !== undefined) {
      try {
        const doc = migrateLegacy(legacy.value);
        persistDoc(doc);
        return { doc, notice: '旧数据已升级，原有比赛、成绩和抗议已保留' };
      } catch {
        /* 旧数据无法解析则按全新数据处理 */
      }
    }
    const doc = seedDoc();
    persistDoc(doc);
    return { doc };
  }
  // 主记录损坏：恢复上一可用版本
  const backup = tryRead(BACKUP_KEY);
  if (backup.ok && backup.value !== undefined) {
    const parsed = ledgerSchema.safeParse(backup.value);
    if (parsed.success) {
      persistDoc(parsed.data);
      return { doc: parsed.data, notice: '主记录损坏，已恢复上一可用版本' };
    }
  }
  stashCorrupt(main.ok ? main.value : localStorage.getItem(LEDGER_KEY));
  const doc = seedDoc();
  persistDoc(doc);
  return { doc, notice: '本地记录无法解析，已重置为初始数据（损坏副本已保留）' };
}

export type CommitResult =
  | { ok: true; doc: LedgerDoc; rebased: boolean; fromRevision: number }
  | { ok: false; kind: 'conflict' | 'blocked' | 'error'; doc: LedgerDoc; message: string; reasons?: string[] };

/**
 * 乐观并发提交：在锁内重读最新账本，若修订号已变化，则把本次操作重放到最新数据上
 * （后交者基于他人记录继续写，而不是整树覆盖）；操作本身不再适用时拒绝并返回最新账本。
 */
export async function commitLedger(baseRevision: number, mutate: (doc: LedgerDoc) => LedgerDoc): Promise<CommitResult> {
  const run = (): CommitResult => {
    const { doc: latest } = loadLedger();
    const rebased = latest.revision !== baseRevision;
    let next: LedgerDoc;
    try {
      next = mutate(latest);
    } catch (err) {
      if (err instanceof StaleActionError) {
        return { ok: false, kind: 'conflict', doc: latest, message: err.message };
      }
      if (err instanceof PublishBlockedError) {
        return { ok: false, kind: 'blocked', doc: latest, message: err.message, reasons: err.reasons };
      }
      throw err;
    }
    const committed: LedgerDoc = { ...next, revision: latest.revision + 1, savedAt: new Date().toISOString() };
    try {
      persistDoc(committed);
    } catch {
      return { ok: false, kind: 'error', doc: latest, message: '本地存储写入失败，已保留上一可用版本' };
    }
    return { ok: true, doc: committed, rebased, fromRevision: latest.revision };
  };
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  if (locks?.request) {
    return locks.request(LOCK_NAME, () => run());
  }
  return Promise.resolve(run());
}

/** 其他标签页写入账本时回调（storage 事件只在本标签页之外的页面触发） */
export function subscribeLedger(callback: (doc: LedgerDoc) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (event: StorageEvent) => {
    if (event.key !== LEDGER_KEY || event.newValue == null) return;
    try {
      const parsed = ledgerSchema.safeParse(JSON.parse(event.newValue));
      if (parsed.success) callback(parsed.data);
    } catch {
      /* 忽略无法解析的广播 */
    }
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}

type DraftKind = 'resultForm' | 'protestForm';
const draftKey = (kind: DraftKind) => `regatta-draft-${kind}-v1`;

/** 未完成草稿独立存放，不占用共享账本修订号，重新打开页面可找回 */
export function loadDraft(kind: 'resultForm'): ResultDraft | undefined;
export function loadDraft(kind: 'protestForm'): ProtestDraft | undefined;
export function loadDraft(kind: DraftKind): ResultDraft | ProtestDraft | undefined {
  try {
    const text = localStorage.getItem(draftKey(kind));
    return text ? (JSON.parse(text) as ResultDraft | ProtestDraft) : undefined;
  } catch {
    return undefined;
  }
}

export function saveDraft(kind: DraftKind, value: ResultDraft | ProtestDraft | undefined): void {
  try {
    if (value === undefined) localStorage.removeItem(draftKey(kind));
    else localStorage.setItem(draftKey(kind), JSON.stringify(value));
  } catch {
    /* 草稿保存失败不影响主流程 */
  }
}
