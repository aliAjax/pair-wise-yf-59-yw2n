import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Alert, Badge, Button, Card, Col, Collapse, Descriptions, Empty, Form, Input, Layout, List, Menu, Row, Space, Statistic, Table, Tag, Timeline, Typography, message } from 'antd';
import { ClockCircleOutlined, FlagOutlined, PlusOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import {
  addProtest,
  clearDraft,
  clearPublishError,
  publishResults,
  reloadFromStorage,
  rollbackPublication,
  saveDraft,
  saveResult,
  setRaceStatus,
  transitionProtest,
  store,
  type AppDispatch,
  type RootState
} from './store';
import { useGetOfficialsQuery } from './api';
import { getActivePublication, hasOpenProtests, hasPendingReviewPenalties } from './ledger';
import type { RaceEntry } from './types';

const { Header, Content, Sider } = Layout;

const resultSchema = z.object({
  id: z.string().min(1),
  elapsedSeconds: z.number().positive(),
  penaltySeconds: z.number().min(0),
  note: z.string().max(120)
});
const protestSchema = z.object({
  entryId: z.string().min(1),
  reason: z.string().min(4),
  rule: z.string().min(2)
});

function countdown(target: string, now: number) {
  const seconds = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function RevisionTag() {
  const { t } = useTranslation();
  const revision = useSelector((state: RootState) => state.regatta.revision);
  return <Tag color="blue">{t('revision')} #{revision}</Tag>;
}

function ConflictBanner() {
  const { t } = useTranslation();
  const dispatch = useDispatch<AppDispatch>();
  const conflict = useSelector((state: RootState) => state.regatta.conflict);
  const revision = useSelector((state: RootState) => state.regatta.revision);
  if (!conflict) return null;
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 16 }}
      message={t('conflictTitle')}
      description={t('conflictBody', { rev: revision })}
      action={<Button size="small" onClick={() => dispatch(reloadFromStorage())}>{t('reload')}</Button>}
    />
  );
}

function NeedsRepublishBanner() {
  const { t } = useTranslation();
  const publications = useSelector((state: RootState) => state.regatta.publications);
  const active = getActivePublication(publications);
  if (active || publications.length === 0) return null;
  return <Alert type="error" showIcon style={{ marginBottom: 16 }} message={t('needsRepublish')} />;
}

function ControlPage() {
  const { t } = useTranslation();
  const dispatch = useDispatch<AppDispatch>();
  const race = useSelector((state: RootState) => state.regatta.races[0]);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const publications = useSelector((state: RootState) => state.regatta.publications);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const sorted = useMemo(() => [...entries].sort((a, b) => a.elapsedSeconds + a.penaltySeconds - b.elapsedSeconds - b.penaltySeconds), [entries]);
  const active = getActivePublication(publications);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <ConflictBanner />
      <NeedsRepublishBanner />
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card className="hero-card">
            <Badge status={race.status === 'running' ? 'processing' : 'success'} text={`比赛状态：${race.status}`} />
            <Statistic title="距离起航" value={countdown(race.startsAt, now)} prefix={<ClockCircleOutlined />} />
            <Descriptions column={1} style={{ marginTop: 18 }}>
              <Descriptions.Item label="组别">{race.fleet}</Descriptions.Item>
              <Descriptions.Item label="航线">{race.course}</Descriptions.Item>
              <Descriptions.Item label="发布状态">
                {active ? <Tag color="green">{t('active')}</Tag> : publications.length > 0 ? <Tag color="red">{t('superseded')}</Tag> : <Tag>{t('noPublications')}</Tag>}
              </Descriptions.Item>
            </Descriptions>
            <Space wrap>
              <Button type="primary" icon={<FlagOutlined />} onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'running' }))}>开始比赛</Button>
              <Button onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'finished' }))}>结束比赛</Button>
              <Button onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'scheduled' }))}>重置排队</Button>
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title={t('control')} extra={<Tag color="blue">{sorted.length} 艘参赛船</Tag>}>
            <Table rowKey="id" pagination={false} dataSource={sorted} columns={[
              { title: '排名', render: (_v, _r, index) => index + 1, width: 64 },
              { title: '船名', dataIndex: 'boat' },
              { title: '帆号', dataIndex: 'sailNo' },
              { title: '船长', dataIndex: 'skipper' },
              { title: '当前净用时', render: (_v, r: RaceEntry) => `${r.elapsedSeconds + r.penaltySeconds}s` },
              { title: '状态', render: (_v, r: RaceEntry) => <Tag color={r.resultStatus === 'official' ? 'green' : r.resultStatus === 'corrected' ? 'orange' : 'default'}>{r.resultStatus}</Tag> }
            ]} />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

function DraftRestoreBanner({ draftKey, label, onRestore }: { draftKey: string; label: string; onRestore: (payload: Record<string, unknown>) => void }) {
  const { t } = useTranslation();
  const dispatch = useDispatch<AppDispatch>();
  const draft = useSelector((state: RootState) => state.regatta.drafts[draftKey]);
  // Only surface the draft on reopen (mount), not while the user is typing.
  const [visible, setVisible] = useState(false);
  useEffect(() => { if (draft) setVisible(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!visible || !draft) return null;
  return (
    <Alert
      type="info"
      showIcon
      style={{ marginBottom: 16 }}
      message={t('draftRecovered', { label, time: new Date(draft.savedAt).toLocaleTimeString() })}
      action={
        <Space>
          <Button size="small" type="primary" onClick={() => { onRestore(draft.payload); setVisible(false); }}>{t('draftRestore')}</Button>
          <Button size="small" onClick={() => { dispatch(clearDraft({ key: draftKey })); setVisible(false); }}>{t('draftDiscard')}</Button>
        </Space>
      }
    />
  );
}

function ResultsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const protests = useSelector((state: RootState) => state.regatta.protests);
  const publications = useSelector((state: RootState) => state.regatta.publications);
  const publishError = useSelector((state: RootState) => state.regatta.publishError);
  const { t } = useTranslation();
  const [api, contextHolder] = message.useMessage();
  const { register, handleSubmit, reset, watch, formState: { errors, isDirty } } = useForm<z.infer<typeof resultSchema>>({
    resolver: zodResolver(resultSchema),
    defaultValues: { id: entries[0]?.id, elapsedSeconds: 3200, penaltySeconds: 0, note: '' }
  });

  const formValues = watch();
  useEffect(() => {
    if (!isDirty) return;
    const handle = window.setTimeout(() => dispatch(saveDraft({ key: 'result-edit', payload: formValues })), 800);
    return () => window.clearTimeout(handle);
  }, [formValues, isDirty, dispatch]);

  const submit = (values: z.infer<typeof resultSchema>) => {
    dispatch(saveResult({ ...values, official: false }));
    api.success(t('draftSaved'));
    dispatch(clearDraft({ key: 'result-edit' }));
    reset(values);
  };

  const openProtests = hasOpenProtests(protests);
  const pendingPenalties = hasPendingReviewPenalties(entries);
  const blocked = openProtests || pendingPenalties;
  const active = getActivePublication(publications);

  const handlePublish = () => {
    dispatch(publishResults({ publishedBy: '计时台', note: '' }));
    const err = store.getState().regatta.publishError;
    if (err) {
      api.error(t(err));
      dispatch(clearPublishError());
    } else {
      api.success(t('publishSuccess'));
    }
  };

  const handleRollback = (id: string) => {
    dispatch(rollbackPublication({ id }));
    api.success(t('rollbackSuccess'));
  };

  return (
    <>
      {contextHolder}
      <ConflictBanner />
      <DraftRestoreBanner
        draftKey="result-edit"
        label={t('resultDraftLabel')}
        onRestore={(payload) => reset(payload as z.infer<typeof resultSchema>)}
      />
      <NeedsRepublishBanner />
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card title="成绩更正">
            <Form layout="vertical" onFinish={handleSubmit(submit)}>
              <Form.Item label="参赛船" validateStatus={errors.id ? 'error' : undefined} help={errors.id?.message}>
                <select {...register('id')} className="native-select">{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat} / {entry.sailNo}</option>)}</select>
              </Form.Item>
              <Form.Item label="净用时（秒）"><Input type="number" {...register('elapsedSeconds', { valueAsNumber: true })} /></Form.Item>
              <Form.Item label="处罚秒数"><Input type="number" {...register('penaltySeconds', { valueAsNumber: true })} /></Form.Item>
              <Form.Item label="更正原因"><Input.TextArea rows={3} {...register('note')} /></Form.Item>
              <Button htmlType="submit" type="primary">保存更正</Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title={t('publishResults')} style={{ marginBottom: 18 }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              {openProtests && <Alert type="error" showIcon message={t('openProtestsWarn')} />}
              {pendingPenalties && <Alert type="error" showIcon message={t('pendingPenaltiesWarn')} />}
              {publishError && <Alert type="error" showIcon message={t(publishError)} />}
              <Space>
                <Button type="primary" disabled={blocked} onClick={handlePublish}>{t('publishResults')}</Button>
                {active && <Tag color="green">{t('active')} · #{active.revision}</Tag>}
              </Space>
            </Space>
          </Card>
          <Card title={t('publications')}>
            {publications.length === 0 ? <Empty description={t('noPublications')} /> : (
              <Collapse
                items={publications.map((pub) => ({
                  key: pub.id,
                  label: (
                    <Space>
                      <Tag color={pub.status === 'active' ? 'green' : pub.status === 'superseded' ? 'red' : 'default'}>
                        {pub.status === 'active' ? t('active') : pub.status === 'superseded' ? t('superseded') : t('rolledBack')}
                      </Tag>
                      <span>#{pub.revision}</span>
                      <small>{new Date(pub.publishedAt).toLocaleString()}</small>
                    </Space>
                  ),
                  extra: pub.status !== 'active' ? <Button size="small" onClick={(e) => { e.stopPropagation(); handleRollback(pub.id); }}>{t('rollback')}</Button> : null,
                  children: (
                    <Table
                      rowKey="entryId"
                      size="small"
                      pagination={false}
                      dataSource={pub.rankings}
                      columns={[
                        { title: t('rankings'), dataIndex: 'rank', width: 64 },
                        { title: '船名', dataIndex: 'boat' },
                        { title: '帆号', dataIndex: 'sailNo' },
                        { title: '净用时', dataIndex: 'elapsedSeconds' },
                        { title: '处罚', dataIndex: 'penaltySeconds' },
                        { title: '总用时', dataIndex: 'totalSeconds' }
                      ]}
                    />
                  )
                }))}
              />
            )}
          </Card>
        </Col>
      </Row>
    </>
  );
}

function ProtestsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const protests = useSelector((state: RootState) => state.regatta.protests);
  const timeline = useSelector((state: RootState) => state.regatta.timeline);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const { t } = useTranslation();
  const { register, handleSubmit, reset, watch, formState: { errors, isDirty } } = useForm<z.infer<typeof protestSchema>>({ resolver: zodResolver(protestSchema), defaultValues: { entryId: entries[0]?.id, reason: '', rule: 'RRS 14' } });

  const formValues = watch();
  useEffect(() => {
    if (!isDirty) return;
    const handle = window.setTimeout(() => dispatch(saveDraft({ key: 'protest-edit', payload: formValues })), 800);
    return () => window.clearTimeout(handle);
  }, [formValues, isDirty, dispatch]);

  const submit = (values: z.infer<typeof protestSchema>) => {
    dispatch(addProtest({ raceId: 'race-1', ...values }));
    dispatch(clearDraft({ key: 'protest-edit' }));
    reset({ entryId: entries[0]?.id, reason: '', rule: 'RRS 14' });
  };

  return (
    <Row gutter={[18, 18]}>
      <Col xs={24} lg={9}>
        <ConflictBanner />
        <DraftRestoreBanner
          draftKey="protest-edit"
          label={t('protestDraftLabel')}
          onRestore={(payload) => reset(payload as z.infer<typeof protestSchema>)}
        />
        <Card title="提交抗议">
          <Form layout="vertical" onFinish={handleSubmit(submit)}>
            <Form.Item label="参赛船" validateStatus={errors.entryId ? 'error' : undefined}>
              <select className="native-select" {...register('entryId')}>{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat}</option>)}</select>
            </Form.Item>
            <Form.Item label="适用规则" validateStatus={errors.rule ? 'error' : undefined} help={errors.rule?.message}><Input {...register('rule')} /></Form.Item>
            <Form.Item label="事件描述" validateStatus={errors.reason ? 'error' : undefined} help={errors.reason?.message}><Input.TextArea rows={4} {...register('reason')} /></Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>登记抗议</Button>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={9}>
        <NeedsRepublishBanner />
        <Card title="冲突复核队列">
          {protests.length === 0 ? <Empty /> : <List dataSource={protests} renderItem={(item) => (
            <List.Item>
              <List.Item.Meta
                title={<Space><Tag color={item.status === 'reviewing' ? 'processing' : 'default'}>{item.status}</Tag>{item.rule}</Space>}
                description={<><div>{item.reason}</div><small>{entries.find((entry) => entry.id === item.entryId)?.boat}</small></>}
              />
              <Space direction="vertical">
                <Button size="small" onClick={() => dispatch(transitionProtest({ id: item.id, status: 'reviewing' }))}>进入复核</Button>
                <Button size="small" type="primary" onClick={() => dispatch(transitionProtest({ id: item.id, status: 'resolved', decision: '接受抗议并处以30秒处罚', penaltySeconds: 30 }))}>接受并处罚</Button>
                <Button size="small" danger onClick={() => dispatch(transitionProtest({ id: item.id, status: 'rejected', decision: '证据不足，维持原成绩' }))}>驳回</Button>
              </Space>
            </List.Item>
          )} />}
        </Card>
      </Col>
      <Col xs={24} lg={6}>
        <Card title="事件时间线"><Timeline items={timeline.map((event) => ({ color: event.type === 'protest' ? 'orange' : 'blue', children: <><b>{event.type}</b><div>{event.message}</div><small>{new Date(event.time).toLocaleTimeString()}</small></> }))} /></Card>
      </Col>
    </Row>
  );
}

function Shell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { data = [] } = useGetOfficialsQuery();
  return (
    <AntApp>
      <Layout className="shell">
        <Header className="header">
          <Space><SafetyCertificateOutlined style={{ fontSize: 24 }} /><Typography.Title level={4} style={{ margin: 0, color: 'white' }}>{t('title')}</Typography.Title></Space>
          <Space><RevisionTag /><Tag>{data.length} 名值班人员</Tag><Button ghost onClick={() => void i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh')}>{t('language')}</Button></Space>
        </Header>
        <Layout>
          <Sider width={210} breakpoint="lg" collapsedWidth="0" theme="light">
            <Menu mode="inline" selectedKeys={[location.pathname]} onClick={({ key }) => navigate(key)} items={[
              { key: '/', label: t('control'), icon: <FlagOutlined /> },
              { key: '/results', label: t('results'), icon: <ClockCircleOutlined /> },
              { key: '/protests', label: t('protests'), icon: <SafetyCertificateOutlined /> }
            ]} />
          </Sider>
          <Content className="content"><Routes>
            <Route path="/" element={<ControlPage />} />
            <Route path="/results" element={<ResultsPage />} />
            <Route path="/protests" element={<ProtestsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes></Content>
        </Layout>
      </Layout>
    </AntApp>
  );
}

export default function App() { return <BrowserRouter><Shell /></BrowserRouter>; }
