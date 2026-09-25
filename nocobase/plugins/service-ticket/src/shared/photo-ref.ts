/**
 * 照片的**对外句柄**（Phase 5 / P5-1）—— `photo_ref` 的派生规则。
 *
 * ---------------------------------------------------------------------------
 * 为什么不是直接把 `service_visit_photos.id` 放进 URL
 * ---------------------------------------------------------------------------
 * 读取端点是**匿名**的（Token 即凭证），URL 会长这样：
 *
 *     GET /api/technician/visits/{token}/photos/{ref}
 *
 * 若 `{ref}` 就是自增主键，会有两个问题：
 *   ① **内部主键出站**。本项目对匿名接口的既有口径是"不回内部 id"
 *      （见 `technicianVisit:get`：连 `visit.id` / `ticket.id` 都不回）。
 *      照片 id 一旦出站，"我们这个库有多大、一天多少张照片"就是公开信息。
 *   ② **越权读取靠"猜 id"变成可能**。当前实现会校验"这张照片属于本 token 的
 *      Visit"（所以猜中别人的 id 也读不到），但那是一道**必须写对**的运行时检查。
 *      让 `{ref}` 本身不可猜，等于多一道**结构性**防线 ——
 *      两道同时失效才需要担心，而不是"少写一个 if 就被击穿"。
 *
 * 派生方式：`sha256(photoId + ':' + access_token_hash)` 取前 22 位 base64url。
 *   · **绑定到 Token 哈希** ⇒ 换访（改派/改约换发新 Token）后旧 ref 自然失效，
 *     与"旧链接作废"保持同一节奏；
 *   · **不含 photoId 原值** ⇒ 从 ref 反推不出主键；
 *   · **确定性** ⇒ 服务端不需要额外存列，读取时对"本 Visit 的 ≤6 张照片"
 *     逐个重算比对即可（不引入新表、新迁移）。
 *
 * ⚠️ 它**不是**权限凭证。真正的授权判据是"Token 有效 + 照片属于该 Visit"
 *    （见 action 层 photo handler）。ref 只是让 URL 不携带内部 id 的编码方式 ——
 *    别把它当签名用，也别因为它"看起来像哈希"就省掉属主校验。
 */
import { createHash } from 'node:crypto';

/** ref 的长度（base64url 无填充；22 字符 ≈ 132 位，远超生日碰撞所需） */
export const PHOTO_REF_LENGTH = 22;

/** ref 的字符集（与 TECHNICIAN_TOKEN.PATTERN 同一字符类，便于 nginx 侧一条正则覆盖） */
export const PHOTO_REF_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * 派生一张照片的对外句柄。
 *
 * @param photoId         `service_visit_photos.id`
 * @param accessTokenHash 所属 Visit 的 `access_token_hash`（**不是**明文 token ——
 *                        明文不参与持久化派生，避免"日志/缓存里出现能拼出 ref 的材料"）
 */
export function photoRefOf(photoId: number | string, accessTokenHash: string): string {
  const digest = createHash('sha256')
    .update(`${Number(photoId)}:${String(accessTokenHash)}`)
    .digest('base64url');
  return digest.slice(0, PHOTO_REF_LENGTH);
}
