/**
 * date-range-item-model.tsx —— Q2：本页日期筛选模型（独立名字，不覆盖框架类）
 *
 * 链路（全部走已核实的正式接口）：
 *   ① 本模型只挂在「所有工单 · 创建日期」这一条（由 post-seed 的 flowModels:update 切换 use）；
 *   ② 日期 → `date-range.mjs` 纯函数（Asia/Shanghai 半开，结束=下一自然日零点）；
 *   ③ 查询 → 表格真实 Resource 的 `addFilterGroup('be04.createdAtRange', filter)` + `refresh()`；
 *   ④ 只用 `$dateNotBefore` + `$dateBefore`（`$dateOn`/`$dateBetween` 有终点+1s 缺陷）。
 *
 * 安全要求（用户 §五）：
 *   · 拿不到 Resource / 应用失败 → 显示中文错误，**不清空条件、不查询全量**；
 *   · 非法区间（开始晚于结束）→ 不提交，显示提示；
 *   · 非目标模型一律 `super.render()`。
 */
import React, { useState } from 'react';
import { Alert, Button, DatePicker, Space, Tag } from 'antd';
import dayjs from 'dayjs';
import * as D from './date-range.mjs';

type AnyModel = any;

export const BE04_DATE_MODEL_NAME = 'BE04DateRangeFilterItemModel';
const GROUP_KEY = 'be04.createdAtRange';

export function isTargetAllTicketsCreatedAt(model: AnyModel): boolean {
  try {
    const step = model?.stepParams ?? {};
    const meta = step.__flowSurfaceMeta ?? {};
    const init = step.fieldSettings?.init ?? {};
    return (
      meta.declaredKey === 'all.all-search.createdAt' &&
      init.collectionName === 'serviceTickets' &&
      init.fieldPath === 'createdAt'
    );
  } catch {
    return false;
  }
}

/** 从 filterManager 的配置里反查表格模型，再拿它真实的 Resource */
function resolveResource(model: AnyModel): any | null {
  try {
    const fm = model?.context?.filterManager;
    const cfgs = typeof fm?.getFilterConfigs === 'function' ? fm.getFilterConfigs() : [];
    const hit = (cfgs ?? []).find(
      (c: any) => Array.isArray(c?.filterPaths) && c.filterPaths.some((p: string) => String(p).includes('createdAt')),
    );
    const targetId = hit?.targetId;
    if (!targetId) return null;
    const table = model?.flowEngine?.getModel?.(targetId);
    return table?.context?.resource ?? null;
  } catch {
    return null;
  }
}

type Mode = 'day' | 'month' | 'year' | 'custom';

const MODES: Array<{ key: Mode; label: string }> = [
  { key: 'day', label: '按日' },
  { key: 'month', label: '按月' },
  { key: 'year', label: '按年' },
  { key: 'custom', label: '自定义' },
];

const PRESETS: Array<{ key: string; label: string }> = [
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: 'thisMonth', label: '本月' },
  { key: 'lastMonth', label: '上月' },
  { key: 'thisYear', label: '本年' },
];

export function DateRangeBar(props: { model: AnyModel }) {
  const { model } = props;
  const [mode, setMode] = useState<Mode>('month');
  const [day, setDay] = useState<string>('');
  const [month, setMonth] = useState<string>('');
  const [year, setYear] = useState<string>('');
  const [range, setRange] = useState<[string, string] | null>(null);
  const [applied, setApplied] = useState<any>(null);
  const [error, setError] = useState<string>('');

  const apply = async (r: any, label: string) => {
    setError('');
    if (!r) {
      setError('日期范围无效：开始日期不能晚于结束日期。');
      return;
    }
    const resource = resolveResource(model);
    if (!resource || typeof resource.addFilterGroup !== 'function') {
      setError('日期筛选暂不可用（未找到当前表格的数据源），已保留你选择的日期，未执行查询。');
      return;
    }
    try {
      const filter = D.toFilter(r);
      resource.addFilterGroup(GROUP_KEY, filter);
      if (typeof resource.setPage === 'function') resource.setPage(1); // 改条件回第一页
      await resource.refresh();
      setApplied({ ...r, label });
    } catch (e: any) {
      setError(`日期筛选失败：${e?.message ?? '未知错误'}（未清空已有条件）`);
    }
  };

  const clear = async () => {
    setError('');
    const resource = resolveResource(model);
    try {
      if (resource && typeof resource.removeFilterGroup === 'function') {
        resource.removeFilterGroup(GROUP_KEY);
        if (typeof resource.setPage === 'function') resource.setPage(1);
        await resource.refresh();
      }
      setApplied(null);
      setDay('');
      setMonth('');
      setYear('');
      setRange(null);
    } catch (e: any) {
      setError(`清除日期失败：${e?.message ?? '未知错误'}`);
    }
  };

  const wrap = (style: React.CSSProperties, children: React.ReactNode) => (
    <div style={{ padding: '8px 10px', border: '1px solid #e8e8e8', borderRadius: 8, background: '#fafafa', ...style }}>
      {children}
    </div>
  );

  return wrap(
    {},
    <>
      <Space size={6} wrap>
        {MODES.map((m) => (
          <Button
            key={m.key}
            size="small"
            type={mode === m.key ? 'primary' : 'default'}
            data-testid={`be04-mode-${m.key}`}
            onClick={() => setMode(m.key)}
          >
            {m.label}
          </Button>
        ))}
        <span style={{ width: 8 }} />
        {PRESETS.map((p) => (
          <Button
            key={p.key}
            size="small"
            data-testid={`be04-preset-${p.key}`}
            onClick={() => {
              try {
                const r = D.preset(p.key);
                void apply(r, p.label);
              } catch (e: any) {
                setError(`快捷日期计算失败：${e?.message ?? ''}`);
              }
            }}
          >
            {p.label}
          </Button>
        ))}
        <span style={{ width: 8 }} />
        <Button size="small" danger data-testid="be04-date-clear" onClick={() => void clear()}>
          清除日期
        </Button>
      </Space>

      <div style={{ marginTop: 6 }} data-testid="be04-date-inputs">
        {mode === 'day' && (
          <DatePicker
            size="small"
            placeholder="选择某一天"
            data-testid="be04-day-picker"
            onChange={(_v: any, s: any) => {
              setDay(s);
              if (s) void apply(D.dayRange(s), s);
            }}
          />
        )}
        {mode === 'month' && (
          <DatePicker
            size="small"
            picker="month"
            placeholder="选择某个月"
            data-testid="be04-month-picker"
            onChange={(_v: any, s: any) => {
              setMonth(s);
              if (s) void apply(D.monthRange(s), s);
            }}
          />
        )}
        {mode === 'year' && (
          <DatePicker
            size="small"
            picker="year"
            placeholder="选择某一年"
            data-testid="be04-year-picker"
            onChange={(_v: any, s: any) => {
              setYear(s);
              if (s) void apply(D.yearRange(s), s);
            }}
          />
        )}
        {mode === 'custom' && (
          <Space size={6}>
            <DatePicker
              size="small"
              placeholder="开始日期"
              data-testid="be04-range-start"
              onChange={(_v: any, s: any) => {
                const next: [string, string] = [s, range?.[1] ?? ''];
                setRange(next);
                if (next[0] && next[1]) void apply(D.customRange(next[0], next[1]), `${next[0]} ~ ${next[1]}`);
              }}
            />
            <DatePicker
              size="small"
              placeholder="结束日期"
              data-testid="be04-range-end"
              onChange={(_v: any, s: any) => {
                const next: [string, string] = [range?.[0] ?? '', s];
                setRange(next);
                if (next[0] && next[1]) void apply(D.customRange(next[0], next[1]), `${next[0]} ~ ${next[1]}`);
              }}
            />
          </Space>
        )}
      </div>

      <div style={{ marginTop: 6, fontSize: 12 }} data-testid="be04-date-current">
        {applied ? (
          <Tag color="blue">
            生效中：{applied.label} · {String(applied.start).slice(0, 16).replace('T', ' ')} ~{' '}
            {String(applied.end).slice(0, 16).replace('T', ' ')}（不含结束）
          </Tag>
        ) : (
          <span style={{ color: '#8c8c8c' }}>未设置日期筛选（显示全部）</span>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 6 }} data-testid="be04-date-error">
          <Alert type="error" showIcon message={error} />
        </div>
      )}
    </>,
  );
}

/** 注册独立模型（新名字，不覆盖任何框架模型） */
export function installDateRangeModel(engine: AnyModel): string {
  if (!engine || typeof engine.registerModels !== 'function') return 'no-engine';

  let Base: any = null;
  try {
    Base = typeof engine.getModelClass === 'function' ? engine.getModelClass('FilterFormItemModel') : null;
  } catch {
    Base = null;
  }
  if (!Base || typeof Base !== 'function') return 'no-base-class';

  class BE04DateRangeFilterItemModel extends Base {
    render(): any {
      let hit = false;
      try {
        hit = isTargetAllTicketsCreatedAt(this);
      } catch {
        hit = false;
      }
      if (!hit) return super.render();
      return React.createElement(DateRangeBar, { model: this });
    }
  }

  try {
    engine.registerModels({ [BE04_DATE_MODEL_NAME]: BE04DateRangeFilterItemModel });
    return 'ok';
  } catch (error: any) {
    return `error:${error?.message ?? String(error)}`;
  }
}
