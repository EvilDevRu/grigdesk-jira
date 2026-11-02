import { TrackerError } from '../types/contract.ts';
import type { TaskData } from '../types/contract.ts';
import { numericId } from './mapping.ts';
import { isRecord } from './objects.ts';

const FIELDS = new Set([
  'title', 'description', 'deadline', 'responsibleId', 'groupId', 'priority',
  'accomplices', 'auditors',
]);

/**
 * Jira хранит срок только датой: ISO-время принимается, но в REST уходит YYYY-MM-DD.
 * null снимает срок; произвольная строка не становится датой по эвристике Date.parse.
 */
function deadline(value: unknown): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new TrackerError('b24_bad_request', 'Срок задачи должен быть ISO-датой или null');
  }

  return value.slice(0, 10);
}

/**
 * Частичная правка не дополняет пропуски и сохраняет пустое описание и снятие срока.
 * Неподдерживаемые роли отвергаются явно, даже при попытке очистить их пустым массивом.
 */
export function taskUpdateFields(input: unknown): TaskData {
  if (!isRecord(input) || !Object.keys(input).length) {
    throw new TrackerError('b24_bad_request', 'Нужен непустой объект полей задачи');
  }

  const fields: TaskData = {};

  for (const [key, value] of Object.entries(input)) {
    if (!FIELDS.has(key)) {
      throw new TrackerError('b24_bad_request', 'Неизвестное поле задачи');
    }

    if (key === 'accomplices' || key === 'auditors') {
      throw new TrackerError('b24_bad_request', 'Jira не поддерживает соисполнителей и наблюдателей');
    }

    if (value === undefined) {
      continue;
    }

    if (key === 'title') {
      if (typeof value !== 'string' || !value.trim()) {
        throw new TrackerError('b24_bad_request', 'Заголовок задачи не может быть пустым');
      }

      fields.summary = value;
    }

    if (key === 'description') {
      if (typeof value !== 'string') {
        throw new TrackerError('b24_bad_request', 'Описание задачи должно быть строкой');
      }

      fields.description = value;
    }

    if (key === 'deadline') {
      fields.duedate = deadline(value);
    }

    if (key === 'responsibleId') {
      if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()
        || String(value).trim().length > 100
        || (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0))) {
        throw new TrackerError('b24_bad_request', 'Исполнитель: нужен accountId до 100 символов');
      }

      fields.assignee = { accountId: String(value).trim() };
    }

    if (key === 'groupId') {
      fields.project = { id: String(numericId(value)) };
    }

    if (key === 'priority') {
      if (![0, 1, 2].includes(value as number)) {
        throw new TrackerError('b24_bad_request', 'Приоритет задачи должен быть 0, 1 или 2');
      }

      fields.priority = value;
    }
  }

  if (!Object.keys(fields).length) {
    throw new TrackerError('b24_bad_request', 'Не передано ни одного изменения задачи');
  }

  return fields;
}

/**
 * Замена labels всегда отправляется JSON-массивом, включая пустой список очистки.
 * Ограничения повторяют входной контракт ядра для прямого использования пакета.
 */
export function taskTags(tags: unknown): string[] {
  if (!Array.isArray(tags) || tags.length > 50 || tags.some((tag) => typeof tag !== 'string'
    || !tag.trim() || tag.trim().length > 100)) {
    throw new TrackerError('b24_bad_request', 'Теги: нужен массив до 50 непустых строк');
  }

  return tags.map((tag) => tag.trim());
}
