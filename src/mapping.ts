import { TrackerError } from '../types/contract.ts';
import type { TaskData } from '../types/contract.ts';
import { isRecord } from './objects.ts';

const PRIORITIES = [
  ['lowest', 'low'],
  ['medium', 'normal'],
  ['high', 'highest', 'critical'],
];
const TEXT_ENTITIES: Record<string, string> = {
  '&': '&#38;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Внешний renderer GrigDesk принимает HTML-подобное описание: строка Jira становится текстом.
 * Числовой ampersand сохраняет буквальные entities при последовательном декодировании renderer.
 */
function descriptionText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[&<>"']/gu, (symbol) => TEXT_ENTITIES[symbol]) : '';
}

/**
 * Имена приоритетов сравниваются без учёта регистра, неизвестный считается обычным.
 * Та же таблица выбирает первый подходящий приоритет при записи на конкретный сайт.
 */
export function priorityValue(name: unknown): number | null {
  const index = PRIORITIES.findIndex((names) => names.includes(String(name).toLowerCase()));

  return index < 0 ? null : index;
}

/**
 * Канонический номер задачи и проекта состоит из цифр и помещается в безопасное целое.
 * Ключ задачи хранится отдельно: HTTP-мутации ядра принимают только числовой номер.
 */
export function numericId(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/u.test(String(value))
    || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new TrackerError('b24_bad_request', 'Нужен положительный числовой id Jira');
  }

  return Number(value);
}

/**
 * Отсутствующий исполнитель остаётся null, accountId сохраняется строкой.
 * На показ передаётся только displayName, приватные email и ссылки аватаров не нужны.
 */
export function user(value: unknown): TaskData | null {
  if (!isRecord(value) || typeof value.accountId !== 'string' || !value.accountId) {
    return null;
  }

  return { id: value.accountId, name: String(value.displayName ?? '') };
}

/**
 * Маппинг общий для карточки и трёх списков; vendor-статус не интерпретирует ядро.
 * Просрочка сравнивает календарные даты UTC: задача на сегодня ещё не просрочена.
 */
export function task(value: unknown): TaskData {
  if (!isRecord(value) || !isRecord(value.fields) || typeof value.key !== 'string' || !value.key) {
    throw new TrackerError('tracker_rest_error', 'Jira не вернула поля задачи и ключ', 502);
  }

  const fields = value.fields;
  const status = isRecord(fields.status) ? fields.status : {};
  const category = isRecord(status.statusCategory) ? String(status.statusCategory.key) : '';
  const kinds: Record<string, string> = {
    new: 'todo',
    indeterminate: 'in_progress',
    done: 'done',
  };
  const project = isRecord(fields.project) ? fields.project : null;
  const duedate = typeof fields.duedate === 'string' ? fields.duedate : null;
  const priority = isRecord(fields.priority) ? priorityValue(fields.priority.name) : null;
  const parent = isRecord(fields.parent) ? fields.parent : null;

  return {
    id: numericId(value.id),
    key: value.key,
    title: String(fields.summary ?? ''),
    description: descriptionText(fields.description),
    status: String(status.id ?? ''),
    statusKind: kinds[category] ?? 'other',
    statusLabel: String(status.name ?? ''),
    statusText: String(status.name ?? ''),
    deadline: duedate ? `${duedate}T00:00:00.000Z` : null,
    overdue: Boolean(duedate && duedate < new Date().toISOString().slice(0, 10) && category !== 'done'),
    responsible: user(fields.assignee),
    creator: user(fields.creator),
    group: project ? { id: numericId(project.id), name: String(project.name ?? '') } : null,
    priority: priority ?? 1,
    parentId: parent ? numericId(parent.id) : null,
    tags: Array.isArray(fields.labels) ? fields.labels.filter((label) => typeof label === 'string') : [],
  };
}

/**
 * Обсуждение REST v2 сохраняет исходный текст и время, без wiki- или ADF-конверсий.
 * Признаки прочтения и системности API не сообщает, вложения в этой версии отключены.
 */
export function comment(value: unknown): TaskData {
  if (!isRecord(value)) {
    throw new TrackerError('tracker_rest_error', 'Некорректный комментарий Jira', 502);
  }

  const author = user(value.author);

  return {
    id: numericId(value.id),
    authorId: author?.id ?? '',
    author: author?.name ?? '',
    time: String(value.created ?? ''),
    text: typeof value.body === 'string' ? value.body : '',
    isSystem: false,
    unread: false,
    attachments: [],
  };
}

/**
 * Подзадачи приходят внутри issue и показываются вместо отсутствующего чек-листа.
 * Полные карточки детей не запрашиваются: достаточно номера, названия и подписи статуса.
 */
export function subtasks(fields: TaskData): TaskData[] {
  const rows = Array.isArray(fields.subtasks) ? fields.subtasks : [];

  return rows.filter(isRecord).map((row) => {
    const child = isRecord(row.fields) ? row.fields : {};
    const status = isRecord(child.status) ? child.status : {};

    return {
      id: numericId(row.id),
      title: String(child.summary ?? ''),
      statusText: String(status.name ?? ''),
    };
  });
}
