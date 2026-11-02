import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import createDriver from '../../driver.ts';

export const EMAIL = 'jira-user@fixture.example';
export const TOKEN = 'token-"секрет/fixture';
export const ACCOUNT = '712020:fixture-account';

/**
 * Поля соответствуют обычному issue REST v2; отдельные тесты меняют нужную часть.
 * Реальный портал не нужен: сценарии проверяют запросы через контракт host.fetch.
 */
export function issue(id = '42', fields = {}) {
  return {
    id,
    key: `PROJ-${id}`,
    fields: {
      summary: 'Задача Jira',
      description: '<b>Обычный текст</b>\n[без wiki|ссылка]',
      status: {
        id: '10001',
        name: 'В работе',
        statusCategory: { key: 'indeterminate' },
      },
      duedate: '2000-01-02',
      assignee: { accountId: ACCOUNT, displayName: 'Исполнитель' },
      creator: { accountId: 'creator:9', displayName: 'Автор' },
      project: { id: '9', name: 'Проект' },
      priority: { id: '2', name: 'High' },
      parent: { id: '12', key: 'PROJ-12' },
      labels: ['метка', 'label'],
      subtasks: [{
        id: '43',
        key: 'PROJ-43',
        fields: { summary: 'Подзадача', status: { name: 'Готово' } },
      }],
      ...fields,
    },
  };
}

/**
 * Эмулятор проверяет общие инварианты каждого запроса, включая Basic и запрет cookie.
 * respond задаёт отдельный сценарий, неописанный маршрут всегда проваливает тест.
 */
export function fixture({ respond, credentials = {} } = {}) {
  const calls = [];
  const logs = [];
  let values = {
    baseUrl: 'https://jira.fixture',
    email: EMAIL,
    apiToken: TOKEN,
    ...credentials,
  };
  const host = {
    credentials: { read: () => values },
    dataDir: '/fixture',
    cookiePath: '/fixture/не-используется/cookies.json',
    serial: (operation) => operation(),
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
    },
    fetch: async (url, options) => {
      const address = new URL(url);
      const body = options.body === undefined ? undefined : JSON.parse(options.body);
      const call = {
        url,
        path: address.pathname,
        query: address.searchParams,
        options,
        body,
      };

      calls.push(call);
      assert.equal(options.redirect, 'manual');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      assert.equal(options.headers.Authorization,
        `Basic ${Buffer.from(`${values.email.trim()}:${values.apiToken}`).toString('base64')}`);
      assert.equal(options.headers.Cookie, undefined);
      assert.equal(url.includes(TOKEN), false);

      if (respond) {
        const response = await respond(call, calls);

        if (response !== undefined) {
          return response;
        }
      }

      if (call.path.endsWith('/myself')) {
        return Response.json({ accountId: ACCOUNT, displayName: 'Исполнитель' });
      }

      if (call.path === '/rest/api/3/search/jql') {
        return Response.json({ issues: [issue()] });
      }

      if (call.path === '/rest/api/2/issue/42' && options.method === 'GET') {
        return Response.json(issue());
      }

      if (call.path === '/rest/api/3/issue/createmeta') {
        return Response.json({ projects: [{ id: '9', issuetypes: [
          {
            id: '2',
            name: 'Подзадача',
            subtask: true,
          },
          {
            id: '1',
            name: 'История',
            subtask: false,
          },
          {
            id: '3',
            name: 'Задача',
            subtask: false,
          },
        ] }] });
      }

      if (call.path === '/rest/api/2/priority') {
        return Response.json([
          { id: '10', name: 'Low' },
          { id: '11', name: 'Normal' },
          { id: '12', name: 'Highest' },
          { id: '13', name: 'High' },
        ]);
      }

      if (call.path === '/rest/api/2/issue' && options.method === 'POST') {
        return Response.json({ id: '42', key: 'PROJ-42' }, { status: 201 });
      }

      if (call.path === '/rest/api/2/issue/42' && options.method === 'PUT') {
        return new Response(null, { status: 204 });
      }

      throw new Error(`Неописанный маршрут фикстуры: ${options.method} ${call.path}`);
    },
  };

  return {
    driver: createDriver(host),
    calls,
    logs,
    change: (changes) => {
      values = { ...values, ...changes };
    },
  };
}

/**
 * Переходы используют категории назначения, vendor-id статуса не влияет на выбор.
 * Числовой id перехода отличается от id статуса, что обнаруживает неверное POST-тело.
 */
export function transition(id, category) {
  return { id, to: { id: `status-${id}`, statusCategory: { key: category } } };
}
