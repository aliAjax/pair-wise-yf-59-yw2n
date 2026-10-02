import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Draft, PersistedState, Protest, ProtestStatus, Publication, Race, RaceEntry, TimelineEvent } from './types';
import { raceApi } from './api';
import {
  buildPublication,
  getActivePublication,
  getStorageRevision,
  hasOpenProtests,
  hasPendingReviewPenalties,
  loadPersisted,
  savePersisted,
  STORAGE_KEY,
  LEGACY_STORAGE_KEY
} from './ledger';

export interface AppState extends PersistedState {
  /** Set when another tab saved a newer revision; local writes are paused. */
  conflict: boolean;
  /** Human-readable reason the last publish attempt was refused. */
  publishError: string | null;
}

const now = new Date();
const initialStart = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

const initialEntries: RaceEntry[] = [
  { id: 'entry-1', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟', elapsedSeconds: 3168, penaltySeconds: 0, resultStatus: 'provisional', note: '' },
  { id: 'entry-2', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿', elapsedSeconds: 3194, penaltySeconds: 30, resultStatus: 'provisional', note: '标记争议' },
  { id: 'entry-3', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄', elapsedSeconds: 3210, penaltySeconds: 0, resultStatus: 'official', note: '' }
];

const initialState: AppState = {
  version: 2,
  revision: 1,
  races: [{ id: 'race-1', name: '海湾长距离赛 第1轮', fleet: '统一级', course: 'W2 / 东北风 12节', startsAt: initialStart, status: 'scheduled' }],
  entries: initialEntries,
  protests: [{ id: 'protest-1', raceId: 'race-1', entryId: 'entry-2', reason: '起航后发生舷侧接触', rule: 'RRS 14', status: 'reviewing', decision: '', createdAt: now.toISOString() }],
  timeline: [
    { id: 'event-1', time: now.toISOString(), type: 'race', message: '航线 W2 已发布' },
    { id: 'event-2', time: new Date(now.getTime() + 2000).toISOString(), type: 'protest', message: '远岚号抗议进入复核' }
  ],
  publications: [],
  drafts: {},
  conflict: false,
  publishError: null
};

/**
 * Optimistic-concurrency guard.
 * If another tab has persisted a newer revision, pause local writes and flag
 * the conflict instead of overwriting the other desk's records.
 */
function checkConflict(state: AppState): boolean {
  if (getStorageRevision() > state.revision) {
    state.conflict = true;
    return true;
  }
  return false;
}

/** Invalidate the active publication after a protest/penalty change. */
function invalidateActivePublication(state: AppState): void {
  const active = getActivePublication(state.publications);
  if (active) active.status = 'superseded';
}

function bumpRevision(state: AppState): void {
  state.revision += 1;
}

const slice = createSlice({
  name: 'regatta',
  initialState,
  reducers: {
    setRaceStatus(state, action: PayloadAction<{ id: string; status: Race['status'] }>) {
      if (checkConflict(state)) return;
      const race = state.races.find((item) => item.id === action.payload.id);
      if (race) {
        race.status = action.payload.status;
        state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'race', message: `${race.name} 状态更新为 ${race.status}` });
        bumpRevision(state);
      }
    },
    saveResult(state, action: PayloadAction<{ id: string; elapsedSeconds: number; penaltySeconds: number; note: string; official: boolean }>) {
      if (checkConflict(state)) return;
      const entry = state.entries.find((item) => item.id === action.payload.id);
      if (!entry) return;
      const changed = entry.elapsedSeconds !== action.payload.elapsedSeconds || entry.penaltySeconds !== action.payload.penaltySeconds;
      entry.elapsedSeconds = action.payload.elapsedSeconds;
      entry.penaltySeconds = action.payload.penaltySeconds;
      entry.note = action.payload.note;
      entry.resultStatus = action.payload.official ? 'official' : changed ? 'corrected' : 'provisional';
      state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'result', message: `${entry.boat} 成绩更正为 ${entry.elapsedSeconds + entry.penaltySeconds} 秒` });
      if (changed) invalidateActivePublication(state);
      bumpRevision(state);
    },
    addProtest(state, action: PayloadAction<{ raceId: string; entryId: string; reason: string; rule: string }>) {
      if (checkConflict(state)) return;
      const protest: Protest = { id: crypto.randomUUID(), ...action.payload, status: 'submitted', decision: '', createdAt: new Date().toISOString() };
      state.protests.unshift(protest);
      state.timeline.unshift({ id: crypto.randomUUID(), time: protest.createdAt, type: 'protest', message: `收到 ${action.payload.rule} 抗议，等待复核` });
      bumpRevision(state);
    },
    transitionProtest(state, action: PayloadAction<{ id: string; status: ProtestStatus; decision?: string; penaltySeconds?: number }>) {
      if (checkConflict(state)) return;
      const protest = state.protests.find((item) => item.id === action.payload.id);
      if (!protest) return;
      protest.status = action.payload.status;
      protest.decision = action.payload.decision ?? protest.decision;
      if (action.payload.status === 'resolved' && action.payload.penaltySeconds) {
        const entry = state.entries.find((item) => item.id === protest.entryId);
        if (entry) {
          entry.penaltySeconds = action.payload.penaltySeconds;
          entry.resultStatus = 'corrected';
        }
      }
      state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'protest', message: `抗议 ${action.payload.id.slice(0, 6)} 更新为 ${action.payload.status}` });
      if (action.payload.status === 'resolved' || action.payload.status === 'rejected') {
        invalidateActivePublication(state);
      }
      bumpRevision(state);
    },
    publishResults(state, action: PayloadAction<{ publishedBy: string; note: string }>) {
      if (checkConflict(state)) return;
      if (hasOpenProtests(state.protests)) {
        state.publishError = 'openProtestsWarn';
        return;
      }
      if (hasPendingReviewPenalties(state.entries)) {
        state.publishError = 'pendingPenaltiesWarn';
        return;
      }
      state.publishError = null;
      const active = getActivePublication(state.publications);
      if (active) active.status = 'superseded';
      const publication = buildPublication(state, action.payload.publishedBy, action.payload.note);
      state.publications.unshift(publication);
      for (const entry of state.entries) entry.resultStatus = 'official';
      state.timeline.unshift({ id: crypto.randomUUID(), time: publication.publishedAt, type: 'system', message: `正式成绩已发布（修订号 #${state.revision}）` });
      bumpRevision(state);
    },
    rollbackPublication(state, action: PayloadAction<{ id: string }>) {
      if (checkConflict(state)) return;
      const target = state.publications.find((item) => item.id === action.payload.id);
      if (!target) return;
      const active = getActivePublication(state.publications);
      if (active && active.id !== target.id) active.status = 'superseded';
      target.status = 'active';
      state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'system', message: `已回滚到发布版本 ${target.id.slice(0, 8)}` });
      bumpRevision(state);
    },
    saveDraft(state, action: PayloadAction<{ key: string; payload: Record<string, unknown> }>) {
      const draft: Draft = { key: action.payload.key, payload: action.payload.payload, savedAt: new Date().toISOString() };
      state.drafts[action.payload.key] = draft;
    },
    clearDraft(state, action: PayloadAction<{ key: string }>) {
      delete state.drafts[action.payload.key];
    },
    remoteUpdate(state, action: PayloadAction<PersistedState>) {
      // Preserve local drafts that are newer than the remote copy so an
      // in-progress draft isn't wiped by another desk's mutation.
      const mergedDrafts: Record<string, Draft> = { ...action.payload.drafts };
      for (const [key, localDraft] of Object.entries(state.drafts)) {
        const remoteDraft = mergedDrafts[key];
        if (!remoteDraft || new Date(localDraft.savedAt).getTime() > new Date(remoteDraft.savedAt).getTime()) {
          mergedDrafts[key] = localDraft;
        }
      }
      return { ...action.payload, drafts: mergedDrafts, conflict: false, publishError: state.publishError };
    },
    reloadFromStorage(state) {
      const loaded = loadPersisted();
      return { ...loaded, conflict: false, publishError: null };
    },
    clearConflict(state) {
      state.conflict = false;
    },
    clearPublishError(state) {
      state.publishError = null;
    }
  }
});

export const {
  setRaceStatus,
  saveResult,
  addProtest,
  transitionProtest,
  publishResults,
  rollbackPublication,
  saveDraft,
  clearDraft,
  remoteUpdate,
  reloadFromStorage,
  clearConflict,
  clearPublishError
} = slice.actions;

/**
 * First run (no stored ledger) seeds the built-in races/entries/protests.
 * Later runs load the persisted v2 ledger, migrating a legacy v1 blob on the way.
 */
function getPreloadedState(): AppState {
  const hasStored = typeof localStorage !== 'undefined' &&
    (localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY));
  if (hasStored) {
    const loaded = loadPersisted();
    return { ...loaded, conflict: false, publishError: null };
  }
  return initialState;
}

export const store = configureStore({
  reducer: { regatta: slice.reducer, [raceApi.reducerPath]: raceApi.reducer },
  preloadedState: { regatta: getPreloadedState() },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(raceApi.middleware)
});

// Persist only the ledger fields (conflict/publishError are ephemeral UI state).
store.subscribe(() => {
  const s = store.getState().regatta;
  // Never persist a stale state over a newer revision written by another tab;
  // wait for the storage event / reloadFromStorage to adopt the newer revision.
  if (getStorageRevision() > s.revision) return;
  const persisted: PersistedState = {
    version: 2,
    revision: s.revision,
    races: s.races,
    entries: s.entries,
    protests: s.protests,
    timeline: s.timeline,
    publications: s.publications,
    drafts: s.drafts
  };
  savePersisted(persisted);
});

// Cross-tab sync: when another desk persists a newer revision, adopt it so the
// latecomer sees the revision number change instead of overwriting the record.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      const next = JSON.parse(event.newValue) as PersistedState;
      if (next.version === 2 && typeof next.revision === 'number' && next.revision > store.getState().regatta.revision) {
        store.dispatch(remoteUpdate(next));
      }
    } catch {
      /* ignore malformed payloads */
    }
  });
}

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
