import { NO_TRACKER_CAPABILITIES } from '../types/capabilities.ts';
import { TrackerError } from '../types/contract.ts';
import type { TaskTracker, TrackerHost } from '../types/contract.ts';
import { credentials } from './auth.ts';
import { JiraSession } from './session.ts';

/**
 * Драйвер изолирован от ядра и хранит только кеш текущего набора реквизитов.
 * Сессия здесь означает память клиента, HTTP Basic не создаёт cookie или файлов.
 */
export function createJiraTracker(host: TrackerHost, transport: typeof fetch = fetch): TaskTracker {
  let cached: { signature: string; value: JiraSession } | null = null;

  /**
   * Любая операция начинает работу с актуальными настройками host.
   * Смена email, токена или origin исключает использование старых кешей.
   */
  function session(): JiraSession {
    const creds = credentials(host.credentials.read());
    const signature = JSON.stringify(creds);

    if (cached?.signature !== signature) {
      cached = { signature, value: new JiraSession(creds, transport) };
    }

    return cached.value;
  }

  return {
    id: 'grigdesk-jira',
    capabilities: {
      ...NO_TRACKER_CAPABILITIES,
      create: true,
      complete: true,
      renew: true,
      users: true,
      projects: true,
      comments: true,
      editing: true,
      tags: true,
    },
    isConfigured: () => {
      try {
        credentials(host.credentials.read());

        return true;
      } catch {
        return false;
      }
    },
    accountIdentity: async () => session().accountIdentity(),
    testAuth: async () => {
      try {
        await session().accountIdentity();

        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof TrackerError
          ? error.message : 'Не удалось проверить подключение Jira' };
      }
    },
    listTasks: async () => session().listTasks(),
    getDashboard: async () => session().getDashboard(),
    taskDetail: async (id) => session().taskDetail(id),
    taskPageData: async (id) => session().taskPageData(id),
    sourceUrl: async (id) => session().sourceUrl(id),
    createTask: async (input) => session().createTask(input),
    updateTask: async (id, input) => session().updateTask(id, input),
    updateTaskTags: async (id, tags) => session().updateTaskTags(id, tags),
    addComment: async (id, text) => session().addComment(id, text),
    completeTask: async (id) => session().transition(id, true),
    renewTask: async (id) => session().transition(id, false),
    findUsers: async (query) => session().findUsers(query),
    listGroups: async () => session().listGroups(),
    probeTaskNumber: async (id) => {
      try {
        await session().taskDetail(id);

        return 'exists';
      } catch (error) {
        return error instanceof TrackerError && error.code === 'task_not_found' ? 'absent' : 'unknown';
      }
    },
    dispose: async () => {
      cached = null;
    },
  };
}
