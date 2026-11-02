import assert from 'node:assert/strict';
import test from 'node:test';

import { CREATED_JQL, REVIEW_JQL, TASKS_JQL } from '../src/search.ts';
import { fixture, issue } from './fixtures/jira.js';

for (const fallback of [null, 404, 410]) {
  test(`Три списка с пагинацией и всеми статусами, fallback=${fallback}`, async () => {
    const filters = [];
    const { driver, calls } = fixture({ respond: ({ path, body }) => {
      if (path === '/rest/api/3/search/jql' && fallback) {
        return new Response(null, { status: fallback });
      }

      filters.push(body.jql);
      assert.equal(body.maxResults, 100);
      assert.ok(body.fields.includes('duedate'));
      assert.ok(body.fields.includes('labels'));

      const page = fallback ? body.startAt : body.nextPageToken ? 1 : 0;
      const rows = body.jql === TASKS_JQL ? [
        issue('42'),
        issue('43', { status: {
          id: '8',
          name: 'Завершена',
          statusCategory: { key: 'done' },
        } }),
      ] : body.jql === REVIEW_JQL ? [issue('44'), issue('45')] : [issue('46'), issue('47')];

      return Response.json(fallback
        ? {
          issues: [rows[page]],
          startAt: page,
          maxResults: 1,
          total: 2,
        }
        : { issues: [rows[page]], ...(page ? {} : { nextPageToken: 'cursor:next' }) });
    } });
    const dashboard = await driver.getDashboard();

    assert.deepEqual(dashboard.tasks.map((row) => row.id), [42, 43]);
    assert.deepEqual(dashboard.toReview.map((row) => row.id), [44, 45]);
    assert.deepEqual(dashboard.created.map((row) => row.id), [46, 47]);
    assert.deepEqual([...new Set(filters)], [TASKS_JQL, REVIEW_JQL, CREATED_JQL]);
    assert.equal(dashboard.tasks[0].overdue, true);
    assert.equal(dashboard.tasks[1].overdue, false);
    assert.equal(dashboard.tasks[1].statusKind, 'done');
    assert.deepEqual(dashboard.tasks[0].responsible, { id: '712020:fixture-account', name: 'Исполнитель' });
    assert.deepEqual(dashboard.tasks[0].group, { id: 9, name: 'Проект' });
    assert.deepEqual(dashboard.widgets, []);
    assert.equal(Object.hasOwn(dashboard, 'accomplice'), false);
    assert.equal(Object.hasOwn(dashboard, 'auditor'), false);
    assert.equal(calls.length, fallback ? 9 : 6);
  });
}

test('listTasks отправляет только фильтр исполнителя и не удаляет done', async () => {
  const { driver, calls } = fixture({ respond: () => Response.json({ issues: [issue('42', {
    status: { name: 'Готово', statusCategory: { key: 'done' } },
  })] }) });

  assert.equal((await driver.listTasks())[0].statusKind, 'done');
  assert.deepEqual(calls.map((call) => call.body.jql), [TASKS_JQL]);
});

test('Срок сегодня не просрочен; неизвестная категория даёт other', async () => {
  const { driver } = fixture({ respond: () => Response.json({ issues: [issue('42', {
    duedate: new Date().toISOString().slice(0, 10),
    status: {
      id: '9',
      name: 'Особый',
      statusCategory: { key: 'custom' },
    },
  })] }) });
  const [row] = await driver.listTasks();

  assert.equal(row.overdue, false);
  assert.equal(row.statusKind, 'other');
  assert.equal(row.statusLabel, 'Особый');
  assert.equal(row.statusText, 'Особый');
});

test('Повтор курсора поиска — ошибка, без запроса третьей страницы', async () => {
  const { driver, calls } = fixture({ respond: () => Response.json({
    issues: [issue()], nextPageToken: 'same',
  }) });

  await assert.rejects(driver.listTasks(), /курсор/u);
  assert.equal(calls.length, 2);
});

test('Пустая v2 страница до total — ошибка пагинации', async () => {
  const { driver, calls } = fixture({ respond: ({ path }) => path.includes('/3/')
    ? new Response(null, { status: 410 }) : Response.json({
      issues: [],
      startAt: 0,
      total: 1,
    }) });

  await assert.rejects(driver.listTasks(), /пагинация/u);
  assert.equal(calls.length, 2);
});

for (const page of [
  { startAt: 1, total: 0 },
  { startAt: 0, total: -1 },
  { startAt: 0, total: 1.5 },
]) {
  test(`Повреждённая последняя страница v2 отвергается: ${JSON.stringify(page)}`, async () => {
    const { driver } = fixture({ respond: ({ path }) => path.includes('/3/')
      ? new Response(null, { status: 410 }) : Response.json({ ...page, issues: [] }) });

    await assert.rejects(driver.listTasks(), /пагинация/u);
  });
}

for (const status of [401, 403, 429, 500]) {
  test(`Поиск ${status} не запускает fallback`, async () => {
    const { driver, calls } = fixture({ respond: () => new Response(null, { status }) });

    await assert.rejects(driver.listTasks());
    assert.equal(calls.length, 1);
  });
}
