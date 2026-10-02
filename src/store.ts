import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { raceApi } from './api';
import { applyAddProtest, applyMarkReviewed, applyPublish, applySaveResult, applySetRaceStatus, applyTransitionProtest, currentPublication, primaryRaceId } from './domain';
import { commitLedger, loadLedger, subscribeLedger, type CommitResult } from './ledger';
import type { LedgerDoc, ProtestStatus, RaceStatus } from './types';

export interface Notice {
  id: string;
  kind: 'success' | 'warning' | 'error' | 'info';
  text: string;
}

interface LedgerState {
  doc: LedgerDoc;
  notices: Notice[];
}

const boot = loadLedger();
const initialState: LedgerState = {
  doc: boot.doc,
  notices: boot.notice ? [{ id: crypto.randomUUID(), kind: 'info', text: boot.notice }] : []
};

const slice = createSlice({
  name: 'ledger',
  initialState,
  reducers: {
    docLoaded(state, action: PayloadAction<LedgerDoc>) {
      state.doc = action.payload;
    },
    noticePushed(state, action: PayloadAction<{ kind: Notice['kind']; text: string }>) {
      state.notices.push({ id: crypto.randomUUID(), ...action.payload });
    },
    noticeAcked(state, action: PayloadAction<string>) {
      state.notices = state.notices.filter((notice) => notice.id !== action.payload);
    }
  }
});

export const { docLoaded, noticePushed, noticeAcked } = slice.actions;

export const store = configureStore({
  reducer: { ledger: slice.reducer, [raceApi.reducerPath]: raceApi.reducer },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(raceApi.middleware)
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

const raceIdOf = (state: RootState) => primaryRaceId(state.ledger.doc);

function reportCommit(dispatch: AppDispatch, result: CommitResult, okText: (doc: LedgerDoc) => string) {
  dispatch(docLoaded(result.doc));
  if (result.ok) {
    if (result.rebased) {
      dispatch(
        noticePushed({
          kind: 'warning',
          text: `检测到其他标签页的更新（修订 v${result.fromRevision}），你的修改已在最新数据上合并保存为 v${result.doc.revision}`
        })
      );
    }
    dispatch(noticePushed({ kind: 'success', text: okText(result.doc) }));
    return;
  }
  if (result.kind === 'conflict') {
    dispatch(noticePushed({ kind: 'warning', text: `修订号已变化：${result.message}。已加载最新数据，请确认后重试，未覆盖他人记录。` }));
  } else if (result.kind === 'blocked') {
    dispatch(noticePushed({ kind: 'error', text: `无法发布正式成绩：${result.message}` }));
  } else {
    dispatch(noticePushed({ kind: 'error', text: result.message }));
  }
}

const activeVersion = (doc: LedgerDoc) => currentPublication(doc, primaryRaceId(doc))?.version ?? 0;

export const setRaceStatus =
  (payload: { id: string; status: RaceStatus }) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<CommitResult> => {
    const result = await commitLedger(getState().ledger.doc.revision, (doc) => applySetRaceStatus(doc, payload));
    reportCommit(dispatch, result, () => '比赛状态已更新');
    return result;
  };

export const saveResult =
  (payload: { id: string; elapsedSeconds: number; penaltySeconds: number; note: string }) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<CommitResult> => {
    const result = await commitLedger(getState().ledger.doc.revision, (doc) => applySaveResult(doc, payload, raceIdOf(getState())));
    reportCommit(dispatch, result, () => '成绩已更正，标记为待复核');
    return result;
  };

export const addProtest =
  (payload: { raceId: string; entryId: string; reason: string; rule: string }) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<CommitResult> => {
    const result = await commitLedger(getState().ledger.doc.revision, (doc) => applyAddProtest(doc, payload));
    reportCommit(dispatch, result, () => '抗议已登记，进入复核队列');
    return result;
  };

export const transitionProtest =
  (payload: { id: string; status: ProtestStatus; decision?: string; penaltySeconds?: number }) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<CommitResult> => {
    const before = activeVersion(getState().ledger.doc);
    const result = await commitLedger(getState().ledger.doc.revision, (doc) => applyTransitionProtest(doc, payload));
    reportCommit(dispatch, result, (doc) => {
      const version = activeVersion(doc);
      return version > before ? `抗议已处理，名次已重算并发布正式成绩 v${version}` : '抗议处理已记录';
    });
    return result;
  };

export const markReviewed =
  (entryId: string) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<CommitResult> => {
    const before = activeVersion(getState().ledger.doc);
    const result = await commitLedger(getState().ledger.doc.revision, (doc) => applyMarkReviewed(doc, entryId, raceIdOf(getState())));
    reportCommit(dispatch, result, (doc) => {
      const version = activeVersion(doc);
      return version > before ? `复核已确认，名次已重算并发布正式成绩 v${version}` : '复核已确认';
    });
    return result;
  };

export const publishResults =
  () =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<CommitResult> => {
    const result = await commitLedger(getState().ledger.doc.revision, (doc) => applyPublish(doc, raceIdOf(getState())));
    reportCommit(dispatch, result, (doc) => `正式成绩 v${activeVersion(doc)} 已发布`);
    return result;
  };

// 其他标签页写入账本后同步到本页，保证计时台/仲裁台看到同一份数据
if (typeof window !== 'undefined') {
  subscribeLedger((doc) => {
    const current = store.getState().ledger.doc.revision;
    if (doc.revision <= current) return;
    store.dispatch(docLoaded(doc));
    store.dispatch(noticePushed({ kind: 'info', text: `另一标签页已更新数据（修订 v${current} → v${doc.revision}）` }));
  });
}
