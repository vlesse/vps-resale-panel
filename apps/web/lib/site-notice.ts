/**
 * 首页弹窗的内容。要改文案、改联系方式，改这一个文件就够了。
 *
 * 为什么单独拎出来：这段话是**对用户的承诺边界**（机器什么时候会没、
 * 数据丢了算谁的），改它是件需要想一下的事，不该混在组件的 JSX 里
 * 顺手改掉。放在这里也方便你三个月换一次货源时同步调整时限。
 */

/**
 * 弹窗版本号。**改了文案就把这个数字 +1。**
 *
 * 用户点过「知道了」之后就不再看到这个弹窗，直到版本号变了 ——
 * 那时候所有人会重新看到一次。所以调整了到期时限、换了联系方式这类
 * 会影响用户判断的内容，一定要顺手改这里，否则老用户永远看不到新说法。
 */
export const NOTICE_VERSION = 1;

/**
 * 隔多少天再提醒一次。
 *
 * 设成 0 表示点过就永远不再提示。不建议 —— 这是条会让人丢数据的警告，
 * 只说一次，三个月后他早忘了。默认七天一次，够提醒又不至于烦人。
 */
export const REMIND_AFTER_DAYS = 7;

/** 站长邮箱。大客户、批量采购、技术支持都走这里。 */
export const SUPPORT_EMAIL = 'freedomchina2099@gmail.com';

/**
 * Telegram 联系方式，填用户名（不带 @）或者完整的 t.me 链接。
 *
 * **留空的话弹窗里就不显示 Telegram 那一项**，不会出现一个点不开的死链接。
 * 想加上就把你的用户名填进来。
 */
export const SUPPORT_TELEGRAM = '';

/** 机器最短能用多久（用于文案，单位：月） */
export const LIFESPAN_MIN_MONTHS = 1;
/** 机器最长能用多久（用于文案，单位：月） */
export const LIFESPAN_MAX_MONTHS = 2;

/** 备份手册的地址。站内页面，不怕外链失效。 */
export const BACKUP_GUIDE_URL = '/help/backup';

/** 把 SUPPORT_TELEGRAM 拼成能点的链接；没填就返回 null */
export function telegramLink(): { href: string; label: string } | null {
  const raw = SUPPORT_TELEGRAM.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    return { href: raw, label: raw.replace(/^https?:\/\/(t\.me\/)?/i, '@') };
  }
  const handle = raw.replace(/^@/, '');
  return { href: `https://t.me/${handle}`, label: `@${handle}` };
}
