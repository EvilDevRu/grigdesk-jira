import { TrackerError } from '../types/contract.ts';
import type { TaskData, TrackerIdentity } from '../types/contract.ts';
import type { Credentials } from './auth.ts';
import { comment, detail, numericId, priorityValue, subtasks, task, user } from './mapping.ts';
import { isRecord } from './objects.ts';
import { offsetPages } from './pagination.ts';
import { CREATED_JQL, ISSUE_FIELDS, REVIEW_JQL, search, TASKS_JQL } from './search.ts';
import { taskTags, taskUpdateFields } from './taskFields.ts';
import { allowsFallback, createRest } from './transport.ts';
import type { Rest } from './transport.ts';

/**
 * Состояние экземпляра принадлежит точной сигнатуре реквизитов, без cookie и файлов.
 * Уже начатая операция продолжает использовать свой аккаунт даже при смене настроек.
 */
export class JiraSession {
  private readonly rest: Rest;
  private readonly origin: string;
  private identity: Promise<TrackerIdentity> | null = null;
  private readonly issueTypes = new Map<string, Promise<TaskData>>();

  constructor(creds: Credentials, transport: typeof fetch) {
    this.rest = createRest(creds, transport);
    this.origin = creds.origin;
  }

  /**
   * Чтение личности допускает ровно один запасной вызов версии v2 при 404/410.
   * Ошибку не кешируем: следующая явная проверка может подтвердить исправленные права.
   */
  private async readIdentity(): Promise<TrackerIdentity> {
    let value: unknown;

    try {
      value = await this.rest('/rest/api/3/myself');
    } catch (error) {
      if (!allowsFallback(error)) {
        throw error;
      }

      value = await this.rest('/rest/api/2/myself');
    }

    const current = user(value);

    if (!current) {
      throw new TrackerError('tracker_rest_error', 'Jira не вернула accountId пользователя', 502);
    }

    return { baseUrl: this.origin, userId: String(current.id) };
  }

  /**
   * Одновременные чтения разделяют обещание личности в пределах одного аккаунта.
   * Наружу выходит копия результата, чтобы потребитель не изменил кеш.
   */
  async accountIdentity(): Promise<TrackerIdentity> {
    this.identity ??= this.readIdentity().catch((error) => {
      this.identity = null;

      throw error;
    });

    return { ...await this.identity };
  }

  /**
   * Основной список содержит все статусы исполнителя, в том числе завершённые.
   * Фильтры JQL и семантика статусов целиком принадлежат пакету.
   */
  async listTasks(): Promise<TaskData[]> {
    return search(this.rest, TASKS_JQL);
  }

  /**
   * «На контроле» означает открытые задачи, поставленные другим исполнителям.
   * Роли соисполнителя и наблюдателя отсутствуют, виджеты отключены.
   */
  async getDashboard() {
    const tasks = await this.listTasks();
    const toReview = await search(this.rest, REVIEW_JQL);
    const created = await search(this.rest, CREATED_JQL);

    return {
      tasks,
      toReview,
      created,
      widgets: [],
    };
  }

  /**
   * Задача читается только через v2, где описание является обычной строкой.
   * Номер проверяется до построения URL; ключ не используется для маршрута мутации.
   */
  private async issue(id: string): Promise<TaskData> {
    const value = await this.rest(`/rest/api/2/issue/${numericId(id)}?fields=${ISSUE_FIELDS.join(',')}`);

    if (!isRecord(value) || !isRecord(value.fields)) {
      throw new TrackerError('tracker_rest_error', 'Jira не вернула задачу', 502);
    }

    return value;
  }

  /**
   * Детали не зависят от доступности обсуждения, комментарии запрашиваются отдельно.
   * Проекция карточки сохраняет объект исполнителя и отдельные group_name/group_id.
   */
  async taskDetail(id: string): Promise<TaskData> {
    return detail(await this.issue(id));
  }

  /**
   * Для ссылки нужен актуальный ключ задачи; числовой номер остаётся каноническим id.
   * Адрес строится только на проверенном origin, ключ экранируется как сегмент URL.
   */
  async sourceUrl(id: string): Promise<string> {
    const detail = await this.taskDetail(id);

    return `${this.origin}/browse/${encodeURIComponent(String(detail.key))}`;
  }

  /**
   * Карточка получает все страницы комментариев и подзадачи из issue.
   * Вложения отключены; labels сохраняются обычными строками, пустой список значим.
   */
  async taskPageData(id: string): Promise<TaskData> {
    const issue = await this.issue(id);
    const mapped = task(issue);
    const rows = await offsetPages((startAt) => this.rest(
      `/rest/api/2/issue/${numericId(id)}/comment?startAt=${startAt}&maxResults=100`,
    ), 'comments');
    const comments = rows.map(comment);

    return {
      comments: [...new Map(comments.map((row) => [row.id, row])).values()],
      attachments: [],
      tags: mapped.tags,
      subtasks: subtasks(issue.fields as TaskData),
    };
  }

  /**
   * Приоритет задаётся именем из конкретного сайта, числовые vendor-id не зашиты.
   * Если подходящего имени нет, поле удаляется и остальные изменения сохраняются.
   */
  private async resolvePriority(fields: TaskData): Promise<void> {
    if (!Object.hasOwn(fields, 'priority')) {
      return;
    }

    const values = await this.rest('/rest/api/2/priority');

    if (!Array.isArray(values)) {
      throw new TrackerError('tracker_rest_error', 'Jira не вернула приоритеты', 502);
    }

    const selected = values.filter(isRecord).find((value) => priorityValue(value.name) === fields.priority);

    if (selected) {
      fields.priority = { id: String(selected.id) };
    } else {
      delete fields.priority;
    }
  }

  /**
   * Метаданные дают первый обычный тип задачи проекта, не подзадачу.
   * Недоступные метаданные заменяются стандартным именем Task, без повтора чтения.
   */
  private async readIssueType(projectId: string): Promise<TaskData> {
    try {
      const data = await this.rest(`/rest/api/3/issue/createmeta?projectIds=${projectId}`);
      const projects = isRecord(data) && Array.isArray(data.projects) ? data.projects : [];
      const project = projects.filter(isRecord).find((item) => String(item.id) === projectId);
      const types = project && Array.isArray(project.issuetypes) ? project.issuetypes : [];
      const selected = types.filter(isRecord).find((value) => value.subtask === false);

      if (selected && selected.id !== undefined) {
        return { id: String(selected.id) };
      }
    } catch {
      // API метаданных необязателен: права создания проверит единственная POST-мутация.
    }

    return { name: 'Task' };
  }

  /**
   * Создание требует проект и заголовок, исполнителя Jira определяет по accountId.
   * Тип кешируется по проекту до смены реквизитов; POST создания выполняется один раз.
   */
  async createTask(input: TaskData): Promise<TaskData> {
    const fields = taskUpdateFields(input);

    if (!fields.summary || !isRecord(fields.project)) {
      throw new TrackerError('b24_bad_request', 'Для создания Jira нужны заголовок и числовой id проекта');
    }

    const projectId = String(fields.project.id);

    if (!this.issueTypes.has(projectId)) {
      this.issueTypes.set(projectId, this.readIssueType(projectId));
    }

    fields.issuetype = await this.issueTypes.get(projectId);
    await this.resolvePriority(fields);

    const result = await this.rest('/rest/api/2/issue', 'POST', { fields });

    if (!isRecord(result) || typeof result.key !== 'string' || !result.key) {
      throw new TrackerError('tracker_rest_error', 'Jira не подтвердила создание задачи', 502);
    }

    return {
      ok: true,
      id: numericId(result.id),
      key: result.key,
    };
  }

  /**
   * Обновление передаёт только заданные поля; исходную задачу для слияния не перечитываем.
   * При единственном несопоставимом приоритете запрос изменения не требуется.
   */
  async updateTask(id: string, input: unknown): Promise<TaskData> {
    const issueId = numericId(id);
    const fields = taskUpdateFields(input);

    await this.resolvePriority(fields);

    if (Object.keys(fields).length) {
      await this.rest(`/rest/api/2/issue/${issueId}`, 'PUT', { fields });
    }

    return { ok: true, id: issueId };
  }

  /**
   * Пустой список полностью очищает labels тем же JSON PUT, что заменяет непустой.
   * Сериализация через urlencoded не используется и не теряет пустые массивы.
   */
  async updateTaskTags(id: string, tags: string[]): Promise<TaskData> {
    const issueId = numericId(id);
    const labels = taskTags(tags);

    await this.rest(`/rest/api/2/issue/${issueId}`, 'PUT', { fields: { labels } });

    return { ok: true, id: issueId };
  }

  /**
   * Комментарий создаётся plain text в v2, без ADF и wiki-преобразований.
   * После сбоя повторов нет, чтобы не добавить один текст несколько раз.
   */
  async addComment(id: string, text: unknown): Promise<TaskData> {
    const issueId = numericId(id);

    if (typeof text !== 'string' || !text.trim()) {
      throw new TrackerError('b24_bad_request', 'Пустой комментарий');
    }

    const value = await this.rest(`/rest/api/2/issue/${issueId}/comment`, 'POST', { body: text });

    if (!isRecord(value)) {
      throw new TrackerError('tracker_rest_error', 'Jira не вернула комментарий', 502);
    }

    return { ok: true, commentId: numericId(value.id) };
  }

  /**
   * Переход выбирается по категории назначения, без знания конкретного workflow.
   * Возобновление предпочитает работу, затем To Do; POST перехода никогда не повторяется.
   */
  async transition(id: string, complete: boolean): Promise<TaskData> {
    const path = `/rest/api/2/issue/${numericId(id)}/transitions`;
    const data = await this.rest(path);

    if (!isRecord(data) || !Array.isArray(data.transitions)) {
      throw new TrackerError('tracker_rest_error', 'Jira не вернула доступные переходы', 502);
    }

    const transitions = data.transitions.filter(isRecord);
    const categories = complete ? ['done'] : ['indeterminate', 'to_do', 'new'];
    let selected: TaskData | undefined;

    for (const category of categories) {
      selected = transitions.find((value) => isRecord(value.to) && isRecord(value.to.statusCategory)
        && value.to.statusCategory.key === category);

      if (selected) {
        break;
      }
    }

    if (!selected) {
      throw new TrackerError('b24_bad_request', 'В Jira нет доступного перехода', 400);
    }

    await this.rest(path, 'POST', { transition: { id: String(selected.id) } });

    return { ok: true };
  }

  /**
   * Поиск пользователей возвращает непрозрачные accountId, сохраняя строковый тип.
   * Текст запроса кодируется URLSearchParams и не становится частью маршрута.
   */
  async findUsers(query: string): Promise<TaskData[]> {
    const values = await this.rest(`/rest/api/3/users/search?${new URLSearchParams({ query })}`);

    if (!Array.isArray(values)) {
      throw new TrackerError('tracker_rest_error', 'Jira не вернула пользователей', 502);
    }

    return values.map(user).filter((value): value is TaskData => value !== null);
  }

  /**
   * Проекты читаются до total либо isLast, с учётом фактического размера страницы.
   * Числовой id проекта совместим с входной валидацией groupId ядра.
   */
  async listGroups(): Promise<TaskData[]> {
    const rows = await offsetPages((startAt) => this.rest(
      `/rest/api/3/project/search?startAt=${startAt}&maxResults=100`,
    ), 'values');

    return rows.filter(isRecord).map((value) => ({
      id: numericId(value.id),
      name: String(value.name ?? ''),
    }));
  }
}
