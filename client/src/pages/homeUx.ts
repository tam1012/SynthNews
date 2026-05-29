export type ReaderTab = 'all' | 'news' | 'tech' | 'voz' | 'reddit' | 'digest';
export type ReaderLoadingState = 'feed-only' | 'split';

const DATE_DEEP_LINK_RE = /^\/(\d{2})(\d{2})(\d{4})$/;
const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDateDeepLinkPath(pathname: string): string | null {
  const match = pathname.match(DATE_DEEP_LINK_RE);
  if (!match) return null;

  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  const candidate = new Date(Date.UTC(year, month - 1, day));

  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }

  return `${yearText}-${monthText}-${dayText}`;
}

export function formatDateDeepLink(localDate: string | null | undefined): string | null {
  const match = localDate?.match(LOCAL_DATE_RE);
  if (!match) return null;

  const [, yearText, monthText, dayText] = match;
  const path = `/${dayText}${monthText}${yearText}`;
  return parseDateDeepLinkPath(path) ? path : null;
}

export function getReaderLoadingState({
  isFeedLoading,
  hasArticleDeepLink,
}: {
  isFeedLoading: boolean;
  hasArticleDeepLink: boolean;
}): ReaderLoadingState {
  return isFeedLoading && !hasArticleDeepLink ? 'feed-only' : 'split';
}

export function shouldShowDetailPane({
  tab,
  hasSelectedArticle,
  hasArticleDeepLink,
}: {
  tab: ReaderTab;
  hasSelectedArticle: boolean;
  hasArticleDeepLink: boolean;
}): boolean {
  return tab !== 'digest' && (hasSelectedArticle || hasArticleDeepLink);
}

export function shouldShowRightPane({
  tab,
  hasSelectedArticle,
  hasArticleDeepLink,
}: {
  tab: ReaderTab;
  hasSelectedArticle: boolean;
  hasArticleDeepLink: boolean;
}): boolean {
  return tab === 'digest' || shouldShowDetailPane({ tab, hasSelectedArticle, hasArticleDeepLink });
}

export function shouldShowScrollTopButton(scrollY: number, hasDetailPane: boolean): boolean {
  return !hasDetailPane && scrollY > 420;
}

export function getEmptyFeedMessage({
  isOfflineCache,
  hasFilter,
}: {
  isOfflineCache: boolean;
  hasFilter: boolean;
  tab: ReaderTab;
}): string {
  if (isOfflineCache) return 'Không có dữ liệu đã lưu cho bộ lọc này.';
  if (hasFilter) return 'Không có tin trong nguồn/tab này.';
  return 'Hệ thống đang cào và tóm tắt tin. Hãy quay lại sau.';
}

export function filterArticlesBySelectedDate<T extends { local_date?: string | null; published_at?: string | null }>(articles: T[], selectedDate: string | null): T[] {
  if (!selectedDate) return articles;
  return articles.filter((article) => (article.local_date || article.published_at?.slice(0, 10)) === selectedDate);
}
