import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyAddProtest,
  applyMarkReviewed,
  applyPublish,
  applySaveResult,
  applyTransitionProtest,
  blockingReasons,
  computeStandings,
  currentPublication,
  PublishBlockedError
} from './domain';
import { commitLedger, LEDGER_KEY, loadDraft, loadLedger, saveDraft, seedDoc } from './ledger';
import type { LedgerDoc } from './types';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
  get length() {
    return this.map.size;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
});

const storedDoc = (): LedgerDoc => JSON.parse(storage.getItem(LEDGER_KEY) as string) as LedgerDoc;

describe('账本初始化与旧数据升级', () => {
  it('空存储时播种初始账本', () => {
    const { doc } = loadLedger();
    expect(doc.revision).toBe(1);
    expect(doc.races).toHaveLength(1);
    expect(doc.entries).toHaveLength(3);
    expect(doc.protests).toHaveLength(1);
    expect(currentPublication(doc, 'race-1')?.version).toBe(1);
  });

  it('旧数据升级后保留原有比赛、成绩和抗议', () => {
    const legacy = {
      races: [{ id: 'race-9', name: '旧赛', fleet: '公开组', course: 'W1', startsAt: '2026-09-01T00:00:00.000Z', status: 'finished' }],
      entries: [
        { id: 'e1', boat: '旧船甲', sailNo: 'CHN 1', skipper: '甲', elapsedSeconds: 100, penaltySeconds: 0, resultStatus: 'official', note: '' },
        { id: 'e2', boat: '旧船乙', sailNo: 'CHN 2', skipper: '乙', elapsedSeconds: 120, penaltySeconds: 10, resultStatus: 'provisional', note: '争议' }
      ],
      protests: [{ id: 'p1', raceId: 'race-9', entryId: 'e2', reason: '碰撞', rule: 'RRS 14', status: 'reviewing', decision: '', createdAt: '2026-09-01T01:00:00.000Z' }],
      timeline: [{ id: 't1', time: '2026-09-01T00:30:00.000Z', type: 'race', message: '旧事件' }]
    };
    storage.setItem('regatta-control-v1', JSON.stringify(legacy));
    const { doc, notice } = loadLedger();
    expect(notice).toContain('升级');
    expect(doc.races[0].name).toBe('旧赛');
    expect(doc.entries.map((e) => e.boat)).toEqual(['旧船甲', '旧船乙']);
    expect(doc.protests[0].rule).toBe('RRS 14');
    expect(doc.timeline.some((event) => event.message === '旧事件')).toBe(true);
    // 旧数据含正式成绩 → 补建 v1 发布版本
    const pub = currentPublication(doc, 'race-9');
    expect(pub?.version).toBe(1);
    expect(pub?.standings).toHaveLength(2);
    // 旧键保留不动，作为兜底
    expect(storage.getItem('regatta-control-v1')).not.toBeNull();
  });
});

describe('多标签页乐观并发', () => {
  it('修订号匹配时提交成功并递增', async () => {
    loadLedger();
    const result = await commitLedger(1, (doc) => applySaveResult(doc, { id: 'entry-1', elapsedSeconds: 3000, penaltySeconds: 0, note: '' }, 'race-1'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rebased).toBe(false);
      expect(result.doc.revision).toBe(2);
    }
    expect(storedDoc().revision).toBe(2);
  });

  it('后交者在最新修订上重放，双方记录都保留', async () => {
    loadLedger();
    // 计时台（修订 1）先保存成绩
    const first = await commitLedger(1, (doc) => applySaveResult(doc, { id: 'entry-1', elapsedSeconds: 3000, penaltySeconds: 0, note: '计时台' }, 'race-1'));
    expect(first.ok).toBe(true);
    // 仲裁台仍基于修订 1 提交抗议 → 重放到修订 2 之上
    const second = await commitLedger(1, (doc) => applyAddProtest(doc, { raceId: 'race-1', entryId: 'entry-3', reason: '绕标未让路', rule: 'RRS 18' }));
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.rebased).toBe(true);
      expect(second.fromRevision).toBe(2);
      expect(second.doc.revision).toBe(3);
      // 计时台的更正和仲裁台的抗议都在
      expect(second.doc.entries.find((e) => e.id === 'entry-1')?.elapsedSeconds).toBe(3000);
      expect(second.doc.protests.some((p) => p.rule === 'RRS 18')).toBe(true);
    }
  });

  it('操作不再适用时拒绝，不覆盖他人记录', async () => {
    loadLedger();
    // 仲裁台 A 先结案 protest-1
    await commitLedger(1, (doc) => applyTransitionProtest(doc, { id: 'protest-1', status: 'resolved', decision: '处罚 30 秒', penaltySeconds: 30 }));
    // 仲裁台 B 基于旧修订重复结案 → 拒绝
    const dup = await commitLedger(1, (doc) => applyTransitionProtest(doc, { id: 'protest-1', status: 'rejected', decision: '驳回' }));
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.kind).toBe('conflict');
      const protest = dup.doc.protests.find((p) => p.id === 'protest-1');
      expect(protest?.status).toBe('resolved');
      expect(protest?.decision).toBe('处罚 30 秒');
    }
  });
});

describe('发布门禁与失效重算', () => {
  it('有未结抗议或待复核处罚时不能发布', async () => {
    loadLedger(); // 种子数据含复核中的 protest-1
    const blocked = await commitLedger(1, (doc) => applyPublish(doc, 'race-1'));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.kind).toBe('blocked');
      expect(blocked.reasons?.some((r) => r.includes('抗议'))).toBe(true);
    }
    // 再制造一条待复核处罚
    await commitLedger(1, (doc) => applySaveResult(doc, { id: 'entry-1', elapsedSeconds: 3000, penaltySeconds: 0, note: '' }, 'race-1'));
    const reasons = blockingReasons(storedDoc());
    expect(reasons.some((r) => r.includes('待复核'))).toBe(true);
    expect(reasons.some((r) => r.includes('抗议'))).toBe(true);
  });

  it('抗议处罚生效后已发布名次失效并重算，旧版本仍可查', async () => {
    loadLedger();
    const before = storedDoc();
    const v1 = currentPublication(before, 'race-1');
    expect(v1?.status).toBe('active');
    // 抗议结案并处罚远岚号 60 秒 → 远岚号总用时超过北辰号，名次变化
    const result = await commitLedger(1, (doc) => applyTransitionProtest(doc, { id: 'protest-1', status: 'resolved', decision: '接受抗议', penaltySeconds: 60 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.doc;
    // 旧版本转为历史，名次快照保留可查
    const old = doc.publications.find((p) => p.version === 1);
    expect(old?.status).toBe('superseded');
    expect(old?.standings).toHaveLength(3);
    // 无其他未结事项 → 自动重算发布 v2
    const active = currentPublication(doc, 'race-1');
    expect(active?.version).toBe(2);
    expect(active?.status).toBe('active');
    expect(active?.note).toContain('重算');
    const third = active?.standings.find((s) => s.boat === '远岚号');
    expect(third?.totalSeconds).toBe(3194 + 60);
    expect(third?.rank).toBe(3);
    // 时间线记录了失效与重发
    expect(doc.timeline.some((e) => e.message.includes('已失效'))).toBe(true);
  });

  it('更正未复核时保持失效，复核确认后自动重发', async () => {
    loadLedger();
    // 先制造待复核更正（此时还有未结抗议，不会重发）
    await commitLedger(1, (doc) => applySaveResult(doc, { id: 'entry-3', elapsedSeconds: 3100, penaltySeconds: 0, note: '计时修正' }, 'race-1'));
    let doc = storedDoc();
    expect(currentPublication(doc, 'race-1')?.status).toBe('invalidated');
    // 抗议结案（无处罚）→ 仍有待复核更正，不重发
    await commitLedger(doc.revision, (d) => applyTransitionProtest(d, { id: 'protest-1', status: 'rejected', decision: '证据不足' }));
    doc = storedDoc();
    expect(currentPublication(doc, 'race-1')?.status).toBe('invalidated');
    // 复核确认 → 门禁通过 → 自动重发 v2
    const done = await commitLedger(doc.revision, (d) => applyMarkReviewed(d, 'entry-3', 'race-1'));
    expect(done.ok).toBe(true);
    if (done.ok) {
      const active = currentPublication(done.doc, 'race-1');
      expect(active?.status).toBe('active');
      expect(active?.version).toBe(2);
      expect(done.doc.entries.find((e) => e.id === 'entry-3')?.resultStatus).toBe('official');
    }
  });

  it('已是最新发布时拒绝重复发布', async () => {
    loadLedger();
    await commitLedger(1, (doc) => applyTransitionProtest(doc, { id: 'protest-1', status: 'rejected', decision: '驳回' }));
    const doc = storedDoc();
    // 驳回后自动重发过一轮；再手动发布应被拒绝（无新变更）
    const again = await commitLedger(doc.revision, (d) => applyPublish(d, 'race-1'));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.kind).toBe('blocked');
  });
});

describe('故障恢复与草稿', () => {
  it('主记录损坏时恢复上一可用版本', async () => {
    loadLedger();
    await commitLedger(1, (doc) => applySaveResult(doc, { id: 'entry-1', elapsedSeconds: 3000, penaltySeconds: 0, note: '' }, 'race-1'));
    expect(storedDoc().revision).toBe(2);
    storage.setItem(LEDGER_KEY, '{broken json');
    const { doc, notice } = loadLedger();
    expect(notice).toContain('恢复上一可用版本');
    expect(doc.revision).toBe(2);
    expect(doc.entries.find((e) => e.id === 'entry-1')?.elapsedSeconds).toBe(3000);
  });

  it('存储写入失败时保留上一可用版本', async () => {
    loadLedger();
    const original = storage.setItem.bind(storage);
    storage.setItem = (key: string, value: string) => {
      if (key === LEDGER_KEY) throw new Error('quota exceeded');
      original(key, value);
    };
    const result = await commitLedger(1, (doc) => applySaveResult(doc, { id: 'entry-1', elapsedSeconds: 3000, penaltySeconds: 0, note: '' }, 'race-1'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('error');
    expect(storedDoc().revision).toBe(1);
  });

  it('未完成草稿可找回，提交后清除', () => {
    expect(loadDraft('resultForm')).toBeUndefined();
    saveDraft('resultForm', { id: 'entry-2', elapsedSeconds: 3200, penaltySeconds: 10, note: '写到一半' });
    expect(loadDraft('resultForm')).toEqual({ id: 'entry-2', elapsedSeconds: 3200, penaltySeconds: 10, note: '写到一半' });
    saveDraft('resultForm', undefined);
    expect(loadDraft('resultForm')).toBeUndefined();
  });
});

describe('名次计算', () => {
  it('按净用时加处罚秒排序', () => {
    const doc = seedDoc();
    const standings = computeStandings(doc.entries);
    expect(standings.map((s) => s.boat)).toEqual(['海风号', '北辰号', '远岚号']);
    expect(standings[2].totalSeconds).toBe(3194 + 30);
  });

  it('PublishBlockedError 携带全部门禁原因', () => {
    const doc = seedDoc();
    try {
      applyPublish(doc, 'race-1');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PublishBlockedError);
      expect((err as PublishBlockedError).reasons.length).toBeGreaterThan(0);
    }
  });
});
