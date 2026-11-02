import { TrackerError } from '../types/contract.ts';
import type { TaskData } from '../types/contract.ts';
import { task } from './mapping.ts';
import { isRecord } from './objects.ts';
import { offsetPages } from './pagination.ts';
import { allowsFallback } from './transport.ts';
import type { Rest } from './transport.ts';

export const ISSUE_FIELDS = [
  'summary', 'description', 'status', 'duedate', 'assignee', 'creator', 'project',
  'priority', 'parent', 'labels', 'subtasks',
];
export const TASKS_JQL = 'assignee = currentUser()';
export const REVIEW_JQL
  = 'reporter = currentUser() AND assignee != currentUser() AND statusCategory != Done';
export const CREATED_JQL = 'reporter = currentUser()';

/**
 * Новый поиск читается по непрозрачному курсору до его отсутствия.
 * Повтор курсора означает ошибку API, а не бесконечный цикл чтения.
 */
async function cursorSearch(rest: Rest, jql: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  const seen = new Set<string>();
  let nextPageToken: string | undefined;

  for (;;) {
    const page = await rest('/rest/api/3/search/jql', 'POST', {
      jql,
      fields: ISSUE_FIELDS,
      maxResults: 100,
      ...(nextPageToken === undefined ? {} : { nextPageToken }),
    });

    if (!isRecord(page) || !Array.isArray(page.issues)) {
      throw new TrackerError('tracker_rest_error', 'Jira не вернула результаты поиска', 502);
    }

    rows.push(...page.issues);

    if (page.nextPageToken === undefined || page.nextPageToken === null || page.nextPageToken === '') {
      return rows;
    }

    if (typeof page.nextPageToken !== 'string' || seen.has(page.nextPageToken)) {
      throw new TrackerError('tracker_rest_error', 'Некорректный курсор поиска Jira', 502);
    }

    nextPageToken = page.nextPageToken;
    seen.add(nextPageToken);
  }
}

/**
 * POST поиска является чтением; только HTTP 404/410 разрешает один переход на REST v2.
 * Запасной поиск начинается с нуля, дубликаты номеров между страницами сворачиваются.
 */
export async function search(rest: Rest, jql: string): Promise<TaskData[]> {
  let rows: unknown[];

  try {
    rows = await cursorSearch(rest, jql);
  } catch (error) {
    if (!allowsFallback(error)) {
      throw error;
    }

    rows = await offsetPages((startAt) => rest('/rest/api/2/search', 'POST', {
      jql,
      fields: ISSUE_FIELDS,
      maxResults: 100,
      startAt,
    }), 'issues');
  }

  const mapped = rows.map(task);

  return [...new Map(mapped.map((row) => [row.id, row])).values()];
}
