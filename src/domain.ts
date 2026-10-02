import type { LedgerDoc, Protest, ProtestStatus, Publication, Race, RaceEntry, Standing, TimelineEvent } from './types';

/** 操作所基于的记录已被他人改动，当前操作不再适用（不覆盖、不写入） */
export class StaleActionError extends Error {}

/** 发布门禁未通过 */
export class PublishBlockedError extends Error {
  reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join('；'));
    this.reasons = reasons;
  }
}

const nowIso = () => new Date().toISOString();

function pushEvent(doc: LedgerDoc, type: TimelineEvent['type'], message: string): LedgerDoc {
  const event: TimelineEvent = { id: crypto.randomUUID(), time: nowIso(), type, message };
  return { ...doc, timeline: [event, ...doc.timeline] };
}

/** 按 净用时+处罚秒 重算名次 */
export function computeStandings(entries: RaceEntry[]): Standing[] {
  return [...entries]
    .sort((a, b) => a.elapsedSeconds + a.penaltySeconds - (b.elapsedSeconds + b.penaltySeconds))
    .map((entry, index) => ({
      rank: index + 1,
      entryId: entry.id,
      boat: entry.boat,
      sailNo: entry.sailNo,
      skipper: entry.skipper,
      elapsedSeconds: entry.elapsedSeconds,
      penaltySeconds: entry.penaltySeconds,
      totalSeconds: entry.elapsedSeconds + entry.penaltySeconds
    }));
}

/** 发布门禁：未结抗议 + 待复核处罚 */
export function blockingReasons(doc: LedgerDoc): string[] {
  const reasons: string[] = [];
  for (const protest of doc.protests) {
    if (protest.status === 'submitted' || protest.status === 'reviewing') {
      reasons.push(`抗议 ${protest.id.slice(0, 6)}（${protest.rule}）尚未结案`);
    }
  }
  for (const entry of doc.entries) {
    if (entry.resultStatus === 'corrected') {
      reasons.push(`${entry.boat} 的更正/处罚待复核`);
    }
  }
  return reasons;
}

/** 当前生效中或已失效待重发的发布版本（superseded 仅作历史查询） */
export function currentPublication(doc: LedgerDoc, raceId: string): Publication | undefined {
  return doc.publications.find((p) => p.raceId === raceId && p.status !== 'superseded');
}

/** 迁移数据的比赛 id 不一定是 race-1，统一取第一场 */
export function primaryRaceId(doc: LedgerDoc): string {
  return doc.races[0]?.id ?? 'race-1';
}

function nextVersion(doc: LedgerDoc, raceId: string): number {
  return doc.publications.filter((p) => p.raceId === raceId).reduce((max, p) => Math.max(max, p.version), 0) + 1;
}

function publish(doc: LedgerDoc, raceId: string, note: string): LedgerDoc {
  const publication: Publication = {
    id: crypto.randomUUID(),
    version: nextVersion(doc, raceId),
    raceId,
    publishedAt: nowIso(),
    basisRevision: doc.revision,
    standings: computeStandings(doc.entries),
    status: 'active',
    note
  };
  const publications = [
    publication,
    ...doc.publications.map((p) => (p.raceId === raceId && p.status !== 'superseded' ? { ...p, status: 'superseded' as const } : p))
  ];
  const entries = doc.entries.map((entry) => ({ ...entry, resultStatus: 'official' as const }));
  return pushEvent({ ...doc, publications, entries }, 'result', `正式成绩 v${publication.version} 已发布（${note}）`);
}

/**
 * 影响名次的数据变化后结算发布账：
 * 生效中的版本先失效；若门禁通过则立即重算并自动发布新版本，否则保持失效待人工重发。
 */
function settle(doc: LedgerDoc, raceId: string, reason: string): LedgerDoc {
  const current = currentPublication(doc, raceId);
  if (!current) return doc;
  let next = doc;
  if (current.status === 'active') {
    next = {
      ...doc,
      publications: doc.publications.map((p) => (p.id === current.id ? { ...p, status: 'invalidated' as const, note: reason } : p))
    };
    next = pushEvent(next, 'system', `正式成绩 v${current.version} 已失效：${reason}`);
  }
  const reasons = blockingReasons(next);
  if (reasons.length === 0 && next.entries.length > 0) {
    return publish(next, raceId, '名次重算后自动发布');
  }
  return pushEvent(next, 'system', `名次已重算，待未结事项清理后重新发布（${reasons.join('；')}）`);
}

function sameStandings(a: Standing[], b: Standing[]): boolean {
  return (
    a.length === b.length &&
    a.every((s, i) => s.entryId === b[i].entryId && s.rank === b[i].rank && s.totalSeconds === b[i].totalSeconds && s.penaltySeconds === b[i].penaltySeconds)
  );
}

export function applyPublish(doc: LedgerDoc, raceId: string): LedgerDoc {
  const reasons = blockingReasons(doc);
  if (reasons.length > 0) throw new PublishBlockedError(reasons);
  if (doc.entries.length === 0) throw new PublishBlockedError(['没有可发布的成绩记录']);
  const current = currentPublication(doc, raceId);
  if (current && current.status === 'active' && sameStandings(computeStandings(doc.entries), current.standings)) {
    throw new PublishBlockedError([`正式成绩 v${current.version} 已是最新，没有新的变更需要发布`]);
  }
  return publish(doc, raceId, '竞赛台手动发布');
}

export function applySetRaceStatus(doc: LedgerDoc, payload: { id: string; status: Race['status'] }): LedgerDoc {
  const race = doc.races.find((item) => item.id === payload.id);
  if (!race) throw new StaleActionError('比赛不存在');
  const races = doc.races.map((item) => (item.id === payload.id ? { ...item, status: payload.status } : item));
  return pushEvent({ ...doc, races }, 'race', `${race.name} 状态更新为 ${payload.status}`);
}

export function applySaveResult(
  doc: LedgerDoc,
  payload: { id: string; elapsedSeconds: number; penaltySeconds: number; note: string },
  raceId: string
): LedgerDoc {
  const entry = doc.entries.find((item) => item.id === payload.id);
  if (!entry) throw new StaleActionError('该成绩记录已不存在，可能已被其他标签页移除');
  const changed = entry.elapsedSeconds !== payload.elapsedSeconds || entry.penaltySeconds !== payload.penaltySeconds;
  const entries = doc.entries.map((item) =>
    item.id === payload.id
      ? {
          ...item,
          elapsedSeconds: payload.elapsedSeconds,
          penaltySeconds: payload.penaltySeconds,
          note: payload.note,
          resultStatus: changed ? ('corrected' as const) : item.resultStatus
        }
      : item
  );
  let next = pushEvent(
    { ...doc, entries },
    'result',
    `${entry.boat} 成绩更正为 ${payload.elapsedSeconds + payload.penaltySeconds} 秒${changed ? '，待复核' : ''}`
  );
  return changed ? settle(next, raceId, `${entry.boat} 成绩被更正`) : next;
}

export function applyAddProtest(doc: LedgerDoc, payload: { raceId: string; entryId: string; reason: string; rule: string }): LedgerDoc {
  const entry = doc.entries.find((item) => item.id === payload.entryId);
  if (!entry) throw new StaleActionError('抗议涉及的参赛船不存在');
  const protest: Protest = { id: crypto.randomUUID(), ...payload, status: 'submitted', decision: '', createdAt: nowIso() };
  return pushEvent({ ...doc, protests: [protest, ...doc.protests] }, 'protest', `收到 ${payload.rule} 抗议，等待复核`);
}

export function applyTransitionProtest(
  doc: LedgerDoc,
  payload: { id: string; status: ProtestStatus; decision?: string; penaltySeconds?: number }
): LedgerDoc {
  const protest = doc.protests.find((item) => item.id === payload.id);
  if (!protest) throw new StaleActionError('该抗议记录已不存在');
  if (protest.status === 'resolved' || protest.status === 'rejected') {
    throw new StaleActionError(`该抗议已被处理为「${protest.decision || protest.status}」，不能重复操作`);
  }
  const protests = doc.protests.map((item) =>
    item.id === payload.id ? { ...item, status: payload.status, decision: payload.decision ?? item.decision } : item
  );
  let entries = doc.entries;
  let penaltyApplied = false;
  if (payload.status === 'resolved' && payload.penaltySeconds != null) {
    const target = doc.entries.find((item) => item.id === protest.entryId);
    if (!target) throw new StaleActionError('抗议涉及的参赛船已不存在');
    // 仲裁决定的处罚即已复核，不再计入“待复核处罚”
    entries = doc.entries.map((item) =>
      item.id === target.id ? { ...item, penaltySeconds: payload.penaltySeconds as number, resultStatus: 'provisional' as const } : item
    );
    penaltyApplied = true;
  }
  let next = pushEvent(
    { ...doc, protests, entries },
    'protest',
    `抗议 ${payload.id.slice(0, 6)} 更新为 ${payload.status}${penaltyApplied ? `，处罚 ${payload.penaltySeconds as number} 秒` : ''}`
  );
  if (penaltyApplied) next = settle(next, protest.raceId, `抗议处罚调整（${protest.rule}）`);
  return next;
}

export function applyMarkReviewed(doc: LedgerDoc, entryId: string, raceId: string): LedgerDoc {
  const entry = doc.entries.find((item) => item.id === entryId);
  if (!entry) throw new StaleActionError('该成绩记录已不存在');
  if (entry.resultStatus !== 'corrected') throw new StaleActionError('该记录已被复核或被其他标签页更新');
  const entries = doc.entries.map((item) => (item.id === entryId ? { ...item, resultStatus: 'provisional' as const } : item));
  const next = pushEvent({ ...doc, entries }, 'result', `${entry.boat} 的更正已复核确认`);
  return settle(next, raceId, `${entry.boat} 更正复核完成`);
}
