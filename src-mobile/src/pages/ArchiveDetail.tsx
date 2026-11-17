/**
 * B 页之三：档案详情（阶段时间线 + 照片）。
 *
 * ===========================================================================
 * 照片是**私有资源**，只有一种取法
 * ===========================================================================
 *   `<img src="/api/svc:archivePhotoFile?...">` 必然 401（浏览器不带 Bearer 头）。
 *   必须 `fetch(带 token) → blob → objectURL`，见 `api/media.ts` 的 `useSecurePhoto`。
 *
 *   并且：objectURL 用完必须 revoke。翻十张图后开始卡，通常不是"图片太多"，
 *   而是十份解码后的位图全挂在内存里。
 *
 * ===========================================================================
 * 暖通阶段为什么必须"按顺序"
 * ===========================================================================
 *   服务端 `ARCHIVE_STAGE_ORDER` 六阶段是**业务规则本身**（勘察→方案→管道→
 *   设备→调试→验收）。前端显示的 done/pending 全部来自服务端，
 *   这里不推断"跳过某个阶段"——那会让现场"看起来都做完"而实际上有阶段没检。
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from 'konsta/react';
import { AppShell, PageHeader } from '../components/AppShell';
import { ErrorState, LoadingState, PermissionDeniedState, ServiceStatusBadge, useToast } from '../components/Feedback';
import { HvacProgress, absTime, maskMobile } from '../components/Domain';
import { ArchiveApiAdapter, type ArchivePhotoRow, type ArchiveRow, type ArchiveStageRow } from '../api/archives';
import { archivePhotoFileUrl, useSecurePhoto } from '../api/media';
import {
  ARCHIVE_STATUS_META,
  ARCHIVE_VISIBILITY_META,
  ARCHIVE_TYPE_META,
  HVAC_STAGE_META,
  metaOf,
} from '../design/tokens';
import { ApiError, newRequestId } from '../api/http';
import { navigate } from '../router';
import { useSession } from '../app/session-context';

export function ArchiveDetailPage({ id }: { id: string }) {
  const { caps } = useSession();
  const toast = useToast();
  const [row, setRow] = useState<ArchiveRow | null>(null);
  const [stages, setStages] = useState<ArchiveStageRow[]>([]);
  const [photos, setPhotos] = useState<ArchivePhotoRow[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [photoStage, setPhotoStage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 三个阶段请求并行：互不依赖，串行要多等两个 RTT
      const [r, st, ph] = await Promise.all([
        ArchiveApiAdapter.get(id),
        // 阶段与照片只对暖通/已建档的档案有意义；失败不应阻断主信息展示
        ArchiveApiAdapter.stages(id).catch(() => [] as ArchiveStageRow[]),
        ArchiveApiAdapter.photos(id).catch(() => [] as ArchivePhotoRow[]),
      ]);
      setRow(r);
      setStages(st);
      setPhotos(ph);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <AppShell>
        <PageHeader title="档案详情" back />
        <LoadingState rows={3} />
      </AppShell>
    );
  }

  if (error) {
    return (
      <AppShell>
        <PageHeader title="档案详情" back />
        {error instanceof ApiError && error.isForbidden ? (
          <PermissionDeniedState onBack={() => navigate('/archives')} />
        ) : (
          <ErrorState error={error} onRetry={() => void load()} onBack={() => navigate('/archives')} />
        )}
      </AppShell>
    );
  }

  if (!row) {
    return (
      <AppShell>
        <PageHeader title="档案详情" back />
        <ErrorState error={new ApiError(404, 'NOT_FOUND', '档案不存在或已被移除')} onBack={() => navigate('/archives')} />
      </AppShell>
    );
  }

  const type = ARCHIVE_TYPE_META[String(row.archive_type ?? '')];
  const vis = metaOf(ARCHIVE_VISIBILITY_META, row.visibility, 'neutral');
  const status = metaOf(ARCHIVE_STATUS_META, row.status, 'neutral');
  const shown = photoStage ? photos.filter((p) => p.stage_code === photoStage) : photos;

  return (
    <AppShell>
      {toast.node}
      <PageHeader title={row.archive_no || `档案 #${row.id}`} back subtitle={type?.label} />

      <div className="px-4 pt-3">
        <div className="bg-svc-surface rounded-svc border border-svc-line p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              {/*
                ⚠️ 客户姓名缺失时**不印 '—'**（用户第三节："不要出现无意义的空值组合"）。
                   一张写着「—」的档案头无法回答"这是谁的档案"，
                   而"（未填客户）"至少说明了**是什么情况**（建档时没填）。
                   同行参照：TicketCard 用"（无客户信息）"、ArchiveCard 用"（未填客户）"。
              */}
              <div className="text-svc-ink text-[17px] font-semibold">{row.customer_name || '（未填客户）'}</div>
              {row.service_address ? (
                <div className="text-svc-ink-2 mt-0.5 text-[13px]">{row.service_address}</div>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <ServiceStatusBadge label={vis.label} tone={vis.tone} size="sm" />
              <ServiceStatusBadge label={status.label} tone={status.tone} size="sm" />
            </div>
          </div>

          {row.archive_type === 'hvac' && stages.length > 0 ? (
            <div className="mt-3">
              <HvacProgress stages={stages.map((s) => ({ stage_code: s.stage_code, status: s.status }))} />
            </div>
          ) : null}

          <div className="border-svc-line mt-3 border-t pt-2">
            {/*
              ⚠️ 手机号为空时整行不渲染：`maskMobile('')` 返回的是 '—'，
                  那就是一个"无意义的空值"（详见调用处上面的注释）。
                  号码存在时才显示（掩码形式）。
            */}
            {row.customer_mobile ? <Row k="手机号" v={maskMobile(row.customer_mobile)} /> : null}
            {row.product_description ? <Row k="产品" v={row.product_description} /> : null}
            {row.service_type ? <Row k="服务类型" v={serviceLabel(row.service_type)} /> : null}
            {row.planned_date ? <Row k="计划上门" v={row.planned_date} /> : null}
            {row.completed_at ? <Row k="完成时间" v={absTime(row.completed_at)} /> : null}
            <Row k="建档时间" v={absTime(row.created_at)} />
          </div>
        </div>
      </div>

      {/* 阶段明细（暖通） */}
      {stages.length > 0 ? (
        <div className="px-4 pt-4">
          <div className="text-svc-ink-3 mb-2 px-1 text-[11px] font-medium">施工阶段</div>
          <div className="bg-svc-surface overflow-hidden rounded-svc border border-svc-line">
            {stages.map((s) => {
              const meta = HVAC_STAGE_META[s.stage_code];
              const done = s.status === 'done';
              return (
                <div
                  key={s.id}
                  className="border-svc-line flex items-center gap-3 border-b px-4 py-3 last:border-b-0"
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                      done ? 'bg-svc-success text-white' : 'bg-svc-surface-2 text-svc-ink-3'
                    }`}
                    aria-hidden="true"
                  >
                    {s.stage_order}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className={`text-[13px] ${done ? 'text-svc-ink font-medium' : 'text-svc-ink-2'}`}>
                      {meta?.label ?? s.stage_code}
                    </div>
                    <div className="text-svc-ink-3 text-[11px]">
                      {done ? absTime(s.done_at) : '未完成'}
                      {s.photo_count > 0 ? ` · ${s.photo_count} 张照片` : ''}
                    </div>
                  </div>
                  {s.photo_count > 0 ? (
                    <button
                      className="text-svc-brand min-h-touch px-1 text-[12px]"
                      onClick={() => setPhotoStage((cur) => (cur === s.stage_code ? null : s.stage_code))}
                    >
                      {photoStage === s.stage_code ? '看全部' : '看照片'}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* 照片 */}
      <div className="px-4 pt-4 pb-6">
        <div className="mb-2 flex items-baseline justify-between px-1">
          <span className="text-svc-ink-3 text-[11px] font-medium">现场照片</span>
          {photoStage ? (
            <button className="text-svc-brand text-[12px]" onClick={() => setPhotoStage(null)}>
              显示全部
            </button>
          ) : null}
        </div>
        {shown.length === 0 ? (
          <div className="bg-svc-surface text-svc-ink-3 rounded-svc border border-svc-line px-4 py-6 text-center text-[12px]">
            暂无照片
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-1.5">
            {shown.map((p) => (
              <PhotoTile key={p.id} photo={p} />
            ))}
          </div>
        )}
      </div>

      {caps.archiveCreate && row.visibility === 'draft' ? (
        <div className="px-4 pb-8">
          <Button
            large
            onClick={() => {
              void (async () => {
                try {
                  await ArchiveApiAdapter.publish(row.id, newRequestId());
                  toast.show('已发布');
                  await load();
                } catch (e) {
                  toast.show(e instanceof Error ? e.message : '发布失败', 'danger');
                }
              })();
            }}
            data-testid="archive-publish"
          >
            发布档案（客户可查询）
          </Button>
          <div className="text-svc-ink-3 mt-2 text-center text-[11px]">
            发布后客户凭手机号可查询到这条记录
          </div>
        </div>
      ) : (
        <div className="h-6" />
      )}
    </AppShell>
  );
}

/**
 * 单张照片。
 *
 * ⚠️ 加载失败必须显示"失败"而不是空白：空白在相册里看起来像"这张就是黑的"，
 *    用户不会去查网络。而照片是售后定责的关键证据。
 */
function PhotoTile({ photo }: { photo: ArchivePhotoRow }) {
  const { url, loading, error } = useSecurePhoto(archivePhotoFileUrl(photo.id));
  return (
    <div className="bg-svc-surface-2 relative aspect-square overflow-hidden rounded-svc-sm">
      {loading ? <div className="svc-skeleton absolute inset-0" /> : null}
      {url ? (
        <img
          src={url}
          alt={photo.photo_type || '现场照片'}
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
        />
      ) : error ? (
        <div className="text-svc-ink-3 flex h-full w-full items-center justify-center px-1 text-center text-[10px]">
          加载失败
        </div>
      ) : null}
      {photo.is_public ? (
        <span className="bg-svc-success absolute bottom-1 left-1 rounded px-1 text-[9px] text-white">已公开</span>
      ) : null}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="border-svc-line flex items-start gap-3 border-b py-2 last:border-b-0">
      <span className="text-svc-ink-3 w-[68px] shrink-0 text-[12px]">{k}</span>
      <span className="text-svc-ink min-w-0 flex-1 text-[13px] break-words">{v}</span>
    </div>
  );
}

function serviceLabel(v: string): string {
  const map: Record<string, string> = {
    delivery: '送货安装',
    install: '安装调试',
    repair: '维修检测',
    clean: '清洗保养',
    guide: '使用指导',
    other: '其他',
  };
  return map[v] ?? v;
}
