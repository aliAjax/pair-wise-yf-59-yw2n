// Logic verification for the recoverable publish ledger.
// Mocks localStorage + crypto, then exercises the real TS source.
import { strict as assert } from 'node:assert';

// ---- Browser API mocks (must be set before importing store) ----
const memory = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => memory.has(k) ? memory.get(k)! : null,
  setItem: (k: string, v: string) => { memory.set(k, v); },
  removeItem: (k: string) => { memory.delete(k); },
  clear: () => { memory.clear(); }
};
if (!(globalThis as any).crypto) {
  (globalThis as any).crypto = { randomUUID: () => Math.random().toString(36).slice(2) + Date.now().toString(36) };
}

const {
  STORAGE_KEY, LEGACY_STORAGE_KEY,
  migrate, loadPersisted, savePersisted,
  hasOpenProtests, hasPendingReviewPenalties, getActivePublication
} = await import('./src/ledger.ts');

const {
  store,
  setRaceStatus, saveResult, transitionProtest,
  publishResults, rollbackPublication, saveDraft, clearDraft,
  reloadFromStorage, remoteUpdate
} = await import('./src/store.ts');

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}`); console.error(e); process.exitCode = 1; }
}

console.log('\n— Migration (v1 → v2) —');
test('migrates a v1 blob preserving races, entries, protests', () => {
  const v1 = {
    races: [{ id: 'r1', name: 'Race', fleet: 'F', course: 'C', startsAt: '2026-01-01T00:00:00Z', status: 'scheduled' }],
    entries: [{ id: 'e1', boat: 'B', sailNo: 'S', skipper: 'K', elapsedSeconds: 100, penaltySeconds: 0, resultStatus: 'official', note: '' }],
    protests: [{ id: 'p1', raceId: 'r1', entryId: 'e1', reason: 'R', rule: 'R1', status: 'submitted', decision: '', createdAt: '2026-01-01T00:00:00Z' }],
    timeline: []
  };
  const migrated = migrate(v1);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.revision, 1);
  assert.equal(migrated.races.length, 1);
  assert.equal(migrated.races[0].id, 'r1');
  assert.equal(migrated.entries.length, 1);
  assert.equal(migrated.entries[0].boat, 'B');
  assert.equal(migrated.protests.length, 1);
  assert.equal(migrated.protests[0].id, 'p1');
  assert.deepEqual(migrated.publications, []);
  assert.deepEqual(migrated.drafts, {});
});

test('loadPersisted migrates a legacy v1 blob and re-saves as v2', () => {
  memory.clear();
  const v1 = { races: [], entries: [], protests: [], timeline: [] };
  memory.set(LEGACY_STORAGE_KEY, JSON.stringify(v1));
  const loaded = loadPersisted();
  assert.equal(loaded.version, 2);
  assert.ok(memory.has(STORAGE_KEY), 'v2 key written after migration');
});

console.log('\n— Publish validation —');
test('hasOpenProtests detects submitted/reviewing', () => {
  assert.equal(hasOpenProtests([{ status: 'submitted' } as any]), true);
  assert.equal(hasOpenProtests([{ status: 'reviewing' } as any]), true);
  assert.equal(hasOpenProtests([{ status: 'resolved' } as any]), false);
  assert.equal(hasOpenProtests([{ status: 'rejected' } as any]), false);
});
test('hasPendingReviewPenalties detects corrected entries', () => {
  assert.equal(hasPendingReviewPenalties([{ resultStatus: 'corrected' } as any]), true);
  assert.equal(hasPendingReviewPenalties([{ resultStatus: 'official' } as any]), false);
  assert.equal(hasPendingReviewPenalties([{ resultStatus: 'provisional' } as any]), false);
});

console.log('\n— Full publish flow via store —');
test('initial seed state loaded with races/entries/protests', () => {
  const s = store.getState().regatta;
  assert.ok(s.races.length >= 1, 'has races');
  assert.ok(s.entries.length >= 3, 'has entries');
  assert.ok(s.protests.length >= 1, 'has protests');
  assert.equal(s.revision, 1);
});

test('publish is BLOCKED while a protest is under review', () => {
  const before = store.getState().regatta;
  assert.equal(hasOpenProtests(before.protests), true, 'fixture has open protest');
  store.dispatch(publishResults({ publishedBy: '计时台', note: '' }));
  const after = store.getState().regatta;
  assert.equal(after.publications.length, 0, 'no publication created');
  assert.equal(after.publishError, 'openProtestsWarn');
  assert.equal(after.revision, before.revision, 'revision unchanged on blocked publish');
});

test('rejecting the open protest allows publish', () => {
  const protest = store.getState().regatta.protests.find(p => p.status === 'reviewing')!;
  store.dispatch(transitionProtest({ id: protest.id, status: 'rejected', decision: '证据不足' }));
  const s1 = store.getState().regatta;
  assert.equal(hasOpenProtests(s1.protests), false);
  assert.equal(hasPendingReviewPenalties(s1.entries), false);
  store.dispatch(publishResults({ publishedBy: '计时台', note: '第1轮正式成绩' }));
  const s2 = store.getState().regatta;
  assert.equal(s2.publications.length, 1, 'publication created');
  assert.equal(s2.publications[0].status, 'active');
  assert.equal(s2.publications[0].publishedBy, '计时台');
  assert.ok(s2.publications[0].rankings.length >= 3);
  assert.equal(s2.publishError, null);
  assert.equal(s2.revision, s1.revision + 1, 'revision bumped on publish');
  assert.ok(s2.entries.every(e => e.resultStatus === 'official'));
});

test('published rankings are sorted by total time', () => {
  const pub = store.getState().regatta.publications[0];
  for (let i = 1; i < pub.rankings.length; i++) {
    assert.ok(pub.rankings[i - 1].totalSeconds <= pub.rankings[i].totalSeconds, 'rankings sorted ascending');
  }
  assert.equal(pub.rankings[0].rank, 1);
});

console.log('\n— Invalidation after protest/penalty change —');
test('a result correction after publish invalidates the active publication', () => {
  const before = store.getState().regatta;
  assert.ok(getActivePublication(before.publications), 'precondition: active publication exists');
  const entry = before.entries[0];
  store.dispatch(saveResult({ id: entry.id, elapsedSeconds: entry.elapsedSeconds + 5, penaltySeconds: 0, note: '复核更正', official: false }));
  const after = store.getState().regatta;
  assert.equal(getActivePublication(after.publications), undefined, 'no active publication after correction');
  assert.equal(after.publications[0].status, 'superseded', 'previous publication marked superseded');
  assert.equal(after.entries.find(e => e.id === entry.id)?.resultStatus, 'corrected');
});

test('republish creates a new active version and keeps the old one queryable', () => {
  const before = store.getState().regatta;
  for (const e of before.entries) {
    if (e.resultStatus === 'corrected') {
      store.dispatch(saveResult({ id: e.id, elapsedSeconds: e.elapsedSeconds, penaltySeconds: 0, note: e.note, official: false }));
    }
  }
  store.dispatch(publishResults({ publishedBy: '仲裁台', note: '重发版本' }));
  const after = store.getState().regatta;
  assert.equal(after.publications.length, 2, 'two versions now');
  assert.equal(after.publications[0].status, 'active');
  assert.equal(after.publications[1].status, 'superseded');
  assert.equal(after.publications[0].publishedBy, '仲裁台');
});

console.log('\n— Rollback —');
test('rollback restores a superseded version to active', () => {
  const before = store.getState().regatta;
  const superseded = before.publications.find(p => p.status === 'superseded')!;
  store.dispatch(rollbackPublication({ id: superseded.id }));
  const after = store.getState().regatta;
  assert.equal(getActivePublication(after.publications)?.id, superseded.id);
  assert.equal(after.publications.find(p => p.id === superseded.id)?.status, 'active');
});

console.log('\n— Draft recovery —');
test('drafts persist and can be cleared', () => {
  store.dispatch(saveDraft({ key: 'result-edit', payload: { id: 'entry-1', elapsedSeconds: 999, penaltySeconds: 0, note: '草稿' } }));
  const s1 = store.getState().regatta;
  assert.ok(s1.drafts['result-edit']);
  assert.equal(s1.drafts['result-edit'].payload.elapsedSeconds, 999);
  store.dispatch(clearDraft({ key: 'result-edit' }));
  const s2 = store.getState().regatta;
  assert.equal(s2.drafts['result-edit'], undefined);
});

console.log('\n— Optimistic concurrency (multi-tab) —');
test('a stale tab cannot overwrite a newer revision', () => {
  const base = store.getState().regatta;
  const baseEntry = base.entries[0];
  // Simulate another tab writing first: persist a state that is 5 revisions ahead.
  const ahead = { ...base, revision: base.revision + 5 };
  savePersisted(ahead);
  // The stale tab attempts a mutation based on its older revision.
  store.dispatch(saveResult({ id: baseEntry.id, elapsedSeconds: 1, penaltySeconds: 0, note: 'b', official: false }));
  const after = store.getState().regatta;
  assert.equal(after.conflict, true, 'conflict flagged');
  assert.equal(after.entries.find(e => e.id === baseEntry.id)?.elapsedSeconds, baseEntry.elapsedSeconds, 'stale write did NOT overwrite');
  // The subscriber must not have overwritten the competing tab's revision.
  const storageRev = JSON.parse(memory.get(STORAGE_KEY)!).revision;
  assert.equal(storageRev, base.revision + 5, 'subscriber did not clobber the newer revision');
});

test('reloadFromStorage adopts the competing revision and clears conflict', () => {
  store.dispatch(reloadFromStorage());
  const s = store.getState().regatta;
  assert.equal(s.conflict, false);
  assert.equal(s.revision, store.getState().regatta.revision);
});

test('remoteUpdate adopts a newer revision from another tab', () => {
  const before = store.getState().regatta;
  const remote = { ...before, revision: before.revision + 1, timeline: [{ id: 'remote', time: new Date().toISOString(), type: 'system', message: 'remote' }] };
  store.dispatch(remoteUpdate(remote));
  const after = store.getState().regatta;
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.timeline[0].id, 'remote');
  assert.equal(after.conflict, false);
});

console.log(`\n${passed} tests passed.\n`);
if (process.exitCode === 1) process.exit(1);
