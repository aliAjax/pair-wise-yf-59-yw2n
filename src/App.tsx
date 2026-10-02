import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Alert, Badge, Button, Card, Col, Descriptions, Empty, Form, Input, InputNumber, Layout, List, Menu, Modal, Row, Space, Statistic, Table, Tag, Timeline, Typography } from 'antd';
import { ClockCircleOutlined, FlagOutlined, PlusOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { addProtest, markReviewed, noticeAcked, publishResults, saveResult, setRaceStatus, transitionProtest, type AppDispatch, type RootState } from './store';
import { blockingReasons, computeStandings, currentPublication, primaryRaceId } from './domain';
import { loadDraft, saveDraft } from './ledger';
import { useGetOfficialsQuery } from './api';
import type { Protest, Publication, ResultStatus } from './types';

const { Header, Content, Sider } = Layout;

const resultSchema = z.object({
  id: z.string().min(1),
  elapsedSeconds: z.number().positive('净用时需大于 0'),
  penaltySeconds: z.number().min(0),
  note: z.string().max(120)
});
const protestSchema = z.object({
  entryId: z.string().min(1),
  reason: z.string().min(4),
  rule: z.string().min(2)
});
type ResultFormValues = z.infer<typeof resultSchema>;
type ProtestFormValues = z.infer<typeof protestSchema>;

const RESULT_STATUS_LABEL: Record<ResultStatus, string> = { provisional: '临时', corrected: '待复核', official: '正式' };
const RESULT_STATUS_COLOR: Record<ResultStatus, string> = { provisional: 'default', corrected: 'orange', official: 'green' };
const PROTEST_STATUS_LABEL: Record<Protest['status'], string> = { submitted: '已提交', reviewing: '复核中', resolved: '已结案', rejected: '已驳回' };
const PUBLICATION_STATUS_LABEL: Record<Publication['status'], string> = { active: '生效中', superseded: '历史版本', invalidated: '已失效' };
const PUBLICATION_STATUS_COLOR: Record<Publication['status'], string> = { active: 'green', superseded: 'default', invalidated: 'red' };

function countdown(target: string, now: number) {
  const seconds = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** 把 store 里的通知渲染成 antd message（须挂在 AntApp 内） */
function Notifier() {
  const { message } = AntApp.useApp();
  const notices = useSelector((state: RootState) => state.ledger.notices);
  const dispatch = useDispatch<AppDispatch>();
  useEffect(() => {
    for (const notice of notices) {
      message.open({ type: notice.kind, content: notice.text, duration: 5 });
      dispatch(noticeAcked(notice.id));
    }
  }, [notices, message, dispatch]);
  return null;
}

function ControlPage() {
  const { t } = useTranslation();
  const dispatch = useDispatch<AppDispatch>();
  const doc = useSelector((state: RootState) => state.ledger.doc);
  const race = doc.races[0];
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const standings = useMemo(() => computeStandings(doc.entries), [doc.entries]);
  const current = currentPublication(doc, primaryRaceId(doc));

  if (!race) {
    return <Empty description="暂无比赛数据" />;
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {current?.status === 'invalidated' && (
        <Alert type="warning" showIcon message={`正式成绩 v${current.version} 已失效：${current.note}`} description="下方为按最新数据重算的临时名次，未结事项清理后将重新发布。" />
      )}
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card className="hero-card">
            <Badge status={race.status === 'running' ? 'processing' : 'success'} text={`比赛状态：${race.status}`} />
            <Statistic title="距离起航" value={countdown(race.startsAt, now)} prefix={<ClockCircleOutlined />} />
            <Descriptions column={1} style={{ marginTop: 18 }}>
              <Descriptions.Item label="组别">{race.fleet}</Descriptions.Item>
              <Descriptions.Item label="航线">{race.course}</Descriptions.Item>
            </Descriptions>
            <Space wrap>
              <Button type="primary" icon={<FlagOutlined />} onClick={() => void dispatch(setRaceStatus({ id: race.id, status: 'running' }))}>开始比赛</Button>
              <Button onClick={() => void dispatch(setRaceStatus({ id: race.id, status: 'finished' }))}>结束比赛</Button>
              <Button onClick={() => void dispatch(setRaceStatus({ id: race.id, status: 'scheduled' }))}>重置排队</Button>
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title={t('control')} extra={<Tag color="blue">{standings.length} 艘参赛船</Tag>}>
            <Table rowKey="entryId" pagination={false} dataSource={standings} columns={[
              { title: '排名', dataIndex: 'rank', width: 64 },
              { title: '船名', dataIndex: 'boat' },
              { title: '帆号', dataIndex: 'sailNo' },
              { title: '船长', dataIndex: 'skipper' },
              { title: '总用时', render: (_v, r) => `${r.totalSeconds}s（含处罚 ${r.penaltySeconds}s）` },
              {
                title: '状态',
                render: (_v, r) => {
                  const entry = doc.entries.find((item) => item.id === r.entryId);
                  return entry ? <Tag color={RESULT_STATUS_COLOR[entry.resultStatus]}>{RESULT_STATUS_LABEL[entry.resultStatus]}</Tag> : null;
                }
              }
            ]} />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

function ResultsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const doc = useSelector((state: RootState) => state.ledger.doc);
  const { entries, publications } = doc;
  const blockers = useMemo(() => blockingReasons(doc), [doc]);
  const current = currentPublication(doc, primaryRaceId(doc));
  const [viewing, setViewing] = useState<Publication | null>(null);
  const [draft, setDraft] = useState(() => loadDraft('resultForm'));
  const defaults: ResultFormValues = { id: entries[0]?.id ?? '', elapsedSeconds: 3200, penaltySeconds: 0, note: '' };
  const { register, handleSubmit, reset, watch, formState: { errors } } = useForm<ResultFormValues>({
    resolver: zodResolver(resultSchema),
    defaultValues: { ...defaults, ...draft }
  });
  // 未完成草稿实时落盘，重新打开页面可找回；空表单不占草稿
  useEffect(() => {
    const sub = watch((values) => {
      const candidate = {
        id: values.id ?? '',
        elapsedSeconds: Number.isFinite(values.elapsedSeconds) ? Number(values.elapsedSeconds) : 0,
        penaltySeconds: Number.isFinite(values.penaltySeconds) ? Number(values.penaltySeconds) : 0,
        note: values.note ?? ''
      };
      const empty = candidate.note.trim() === '' && candidate.elapsedSeconds === 3200 && candidate.penaltySeconds === 0;
      saveDraft('resultForm', empty ? undefined : candidate);
    });
    return () => sub.unsubscribe();
  }, [watch]);
  const submit = async (values: ResultFormValues) => {
    const result = await dispatch(saveResult(values));
    if (result.ok) {
      saveDraft('resultForm', undefined);
      setDraft(undefined);
      reset({ id: values.id, elapsedSeconds: 3200, penaltySeconds: 0, note: '' });
    }
  };
  return (
    <>
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card title="成绩更正" extra={draft ? <Tag color="gold">已恢复未完成的草稿</Tag> : undefined}>
            <Form layout="vertical" onFinish={handleSubmit(submit)}>
              <Form.Item label="参赛船" validateStatus={errors.id ? 'error' : undefined} help={errors.id?.message}>
                <select {...register('id')} className="native-select">{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat} / {entry.sailNo}</option>)}</select>
              </Form.Item>
              <Form.Item label="净用时（秒）" validateStatus={errors.elapsedSeconds ? 'error' : undefined} help={errors.elapsedSeconds?.message}>
                <Input type="number" {...register('elapsedSeconds', { valueAsNumber: true })} />
              </Form.Item>
              <Form.Item label="处罚秒数"><Input type="number" {...register('penaltySeconds', { valueAsNumber: true })} /></Form.Item>
              <Form.Item label="更正原因"><Input.TextArea rows={3} {...register('note')} /></Form.Item>
              <Button htmlType="submit" type="primary">保存更正</Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Card
              title="发布正式成绩"
              extra={current
                ? <Tag color={PUBLICATION_STATUS_COLOR[current.status]}>v{current.version} · {PUBLICATION_STATUS_LABEL[current.status]}</Tag>
                : <Tag>未发布</Tag>}
            >
              {blockers.length > 0 ? (
                <Alert
                  type="warning"
                  showIcon
                  message="存在未结事项，正式成绩不能发布"
                  description={<ul style={{ margin: '4px 0 0', paddingInlineStart: 18 }}>{blockers.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
                />
              ) : (
                <Alert type="success" showIcon message="无未结抗议或待复核处罚，可以发布" />
              )}
              <Button type="primary" style={{ marginTop: 12 }} disabled={blockers.length > 0} onClick={() => void dispatch(publishResults())}>
                发布正式成绩
              </Button>
            </Card>
            <Card title="成绩记录">
              <List dataSource={entries} renderItem={(entry) => (
                <List.Item actions={entry.resultStatus === 'corrected'
                  ? [<Button key="review" size="small" type="link" onClick={() => void dispatch(markReviewed(entry.id))}>复核确认</Button>]
                  : []}>
                  <List.Item.Meta title={`${entry.boat} · ${entry.elapsedSeconds + entry.penaltySeconds} 秒`} description={entry.note || '无更正说明'} />
                  <Tag color={RESULT_STATUS_COLOR[entry.resultStatus]}>{RESULT_STATUS_LABEL[entry.resultStatus]}</Tag>
                </List.Item>
              )} />
            </Card>
            <Card title="发布记录（旧版本可查）">
              {publications.length === 0 ? <Empty /> : (
                <List dataSource={publications} renderItem={(pub) => (
                  <List.Item actions={[<Button key="view" size="small" onClick={() => setViewing(pub)}>查看名次</Button>]}>
                    <List.Item.Meta
                      title={<Space><Tag color={PUBLICATION_STATUS_COLOR[pub.status]}>v{pub.version} · {PUBLICATION_STATUS_LABEL[pub.status]}</Tag><small>{new Date(pub.publishedAt).toLocaleString()}</small></Space>}
                      description={pub.note}
                    />
                  </List.Item>
                )} />
              )}
            </Card>
          </Space>
        </Col>
      </Row>
      <Modal open={viewing !== null} footer={null} onCancel={() => setViewing(null)} title={viewing ? `正式成绩 v${viewing.version}（${PUBLICATION_STATUS_LABEL[viewing.status]}）` : ''}>
        {viewing && (
          <>
            <Typography.Paragraph type="secondary">
              发布于 {new Date(viewing.publishedAt).toLocaleString()} · 基于修订 v{viewing.basisRevision} · {viewing.note}
            </Typography.Paragraph>
            <Table rowKey="entryId" pagination={false} size="small" dataSource={viewing.standings} columns={[
              { title: '排名', dataIndex: 'rank', width: 64 },
              { title: '船名', dataIndex: 'boat' },
              { title: '帆号', dataIndex: 'sailNo' },
              { title: '总用时', render: (_v, r) => `${r.totalSeconds}s` },
              { title: '处罚', render: (_v, r) => `${r.penaltySeconds}s` }
            ]} />
          </>
        )}
      </Modal>
    </>
  );
}

function ProtestActions({ protest }: { protest: Protest }) {
  const dispatch = useDispatch<AppDispatch>();
  const [penalty, setPenalty] = useState(30);
  if (protest.status === 'resolved' || protest.status === 'rejected') {
    return <Typography.Text type="secondary">{protest.decision || PROTEST_STATUS_LABEL[protest.status]}</Typography.Text>;
  }
  return (
    <Space direction="vertical">
      <Button size="small" onClick={() => void dispatch(transitionProtest({ id: protest.id, status: 'reviewing' }))}>进入复核</Button>
      <Space>
        <InputNumber size="small" min={0} value={penalty} onChange={(value) => setPenalty(Number(value) || 0)} addonAfter="秒" style={{ width: 110 }} />
        <Button size="small" type="primary" onClick={() => void dispatch(transitionProtest({ id: protest.id, status: 'resolved', decision: `接受抗议并处以 ${penalty} 秒处罚`, penaltySeconds: penalty }))}>接受并处罚</Button>
      </Space>
      <Button size="small" danger onClick={() => void dispatch(transitionProtest({ id: protest.id, status: 'rejected', decision: '证据不足，维持原成绩' }))}>驳回</Button>
    </Space>
  );
}

function ProtestsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const doc = useSelector((state: RootState) => state.ledger.doc);
  const { protests, timeline, entries } = doc;
  const [draft, setDraft] = useState(() => loadDraft('protestForm'));
  const defaults: ProtestFormValues = { entryId: entries[0]?.id ?? '', reason: '', rule: 'RRS 14' };
  const { register, handleSubmit, reset, watch, formState: { errors } } = useForm<ProtestFormValues>({
    resolver: zodResolver(protestSchema),
    defaultValues: { ...defaults, ...draft }
  });
  useEffect(() => {
    const sub = watch((values) => {
      const candidate = { entryId: values.entryId ?? '', reason: values.reason ?? '', rule: values.rule ?? '' };
      saveDraft('protestForm', candidate.reason.trim() === '' ? undefined : candidate);
    });
    return () => sub.unsubscribe();
  }, [watch]);
  const submit = async (values: ProtestFormValues) => {
    const result = await dispatch(addProtest({ raceId: primaryRaceId(doc), ...values }));
    if (result.ok) {
      saveDraft('protestForm', undefined);
      setDraft(undefined);
      reset({ entryId: values.entryId, reason: '', rule: 'RRS 14' });
    }
  };
  return (
    <Row gutter={[18, 18]}>
      <Col xs={24} lg={9}>
        <Card title="提交抗议" extra={draft ? <Tag color="gold">已恢复未完成的草稿</Tag> : undefined}>
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
        <Card title="冲突复核队列">
          {protests.length === 0 ? <Empty /> : <List dataSource={protests} renderItem={(item) => (
            <List.Item>
              <List.Item.Meta
                title={<Space><Tag color={item.status === 'reviewing' ? 'processing' : item.status === 'resolved' ? 'green' : item.status === 'rejected' ? 'red' : 'default'}>{PROTEST_STATUS_LABEL[item.status]}</Tag>{item.rule}</Space>}
                description={<><div>{item.reason}</div><small>{entries.find((entry) => entry.id === item.entryId)?.boat}</small></>}
              />
              <ProtestActions protest={item} />
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
  const doc = useSelector((state: RootState) => state.ledger.doc);
  const current = currentPublication(doc, primaryRaceId(doc));
  return (
    <AntApp>
      <Notifier />
      <Layout className="shell">
      <Header className="header">
        <Space><SafetyCertificateOutlined style={{ fontSize: 24 }} /><Typography.Title level={4} style={{ margin: 0, color: 'white' }}>{t('title')}</Typography.Title></Space>
        <Space wrap>
          <Tag color="geekblue">修订 v{doc.revision}</Tag>
          {current
            ? <Tag color={PUBLICATION_STATUS_COLOR[current.status]}>正式成绩 v{current.version}{current.status === 'invalidated' ? '（已失效）' : ''}</Tag>
            : <Tag>未发布</Tag>}
          <Tag>{data.length} 名值班人员</Tag>
          <Button ghost onClick={() => void i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh')}>{t('language')}</Button>
        </Space>
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
