import { TrackerError } from '../types/contract.ts';
import { isRecord } from './objects.ts';

/**
 * Страничные ответы обязаны продвигать startAt до total либо явного isLast.
 * Повреждённая страница не превращается в молчаливо обрезанный список.
 */
export async function offsetPages(
  load: (startAt: number) => Promise<unknown>,
  field: string,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  let startAt = 0;

  for (;;) {
    const page = await load(startAt);

    if (!isRecord(page) || !Array.isArray(page[field])) {
      throw new TrackerError('tracker_rest_error', 'Jira не вернула страницу списка', 502);
    }

    const items = page[field];
    const next = startAt + items.length;
    const total = page.total;

    if ((page.startAt !== undefined && page.startAt !== startAt)
      || (total !== undefined && (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0))) {
      throw new TrackerError('tracker_rest_error', 'Некорректная пагинация Jira', 502);
    }

    rows.push(...items);

    if (page.isLast === true || (typeof total === 'number' && next >= total)) {
      return rows;
    }

    if (!items.length || (page.isLast !== false && total === undefined)) {
      throw new TrackerError('tracker_rest_error', 'Некорректная пагинация Jira', 502);
    }

    startAt = next;
  }
}
