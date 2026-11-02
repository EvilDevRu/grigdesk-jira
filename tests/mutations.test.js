import assert from 'node:assert/strict';
import test from 'node:test';

import { ACCOUNT, fixture, transition } from './fixtures/jira.js';

test('Создание: createmeta, accountId, plain text, duedate и первый подходящий приоритет', async () => {
  const { driver, calls } = fixture();
  const result = await driver.createTask({
    title: 'Новая задача',
    description: '<b>Текст</b>\n[ссылка]',
    responsibleId: ACCOUNT,
    groupId: 9,
    deadline: '2026-12-31T23:55:00+07:00',
    priority: 2,
  });

  assert.deepEqual(result, {
    ok: true,
    id: 42,
    key: 'PROJ-42',
  });
  assert.equal(calls[0].path, '/rest/api/3/issue/createmeta');
  assert.equal(calls[0].query.get('projectIds'), '9');
  assert.deepEqual(calls.at(-1).body, { fields: {
    summary: 'Новая задача',
    description: '<b>Текст</b>\n[ссылка]',
    assignee: { accountId: ACCOUNT },
    project: { id: '9' },
    duedate: '2026-12-31',
    priority: { id: '12' },
    issuetype: { id: '1' },
  } });
});

test('Тип задачи кешируется до смены реквизитов и отдельно для проекта', async () => {
  const { driver, calls, change } = fixture();

  await driver.createTask({ title: 'Первая', groupId: 9 });
  await driver.createTask({ title: 'Вторая', groupId: 9 });
  assert.equal(calls.filter((call) => call.path.endsWith('/createmeta')).length, 1);
  await driver.createTask({ title: 'Другой проект', groupId: 10 });
  assert.equal(calls.filter((call) => call.path.endsWith('/createmeta')).length, 2);
  change({ apiToken: 'другой-токен' });
  await driver.createTask({ title: 'Другой аккаунт', groupId: 9 });
  assert.equal(calls.filter((call) => call.path.endsWith('/createmeta')).length, 3);
});

test('Недоступный createmeta заменяется типом Task без повторного чтения', async () => {
  const { driver, calls } = fixture({ respond: ({ path }) => {
    if (path.endsWith('/createmeta')) {
      return new Response(null, { status: 410 });
    }
  } });

  await driver.createTask({ title: 'Новая', groupId: 9 });
  assert.deepEqual(calls.at(-1).body.fields.issuetype, { name: 'Task' });
  assert.equal(calls.length, 2);
});

for (const [input, fields] of [
  [{ title: 'Имя' }, { summary: 'Имя' }],
  [{ description: '' }, { description: '' }],
  [{ responsibleId: ACCOUNT }, { assignee: { accountId: ACCOUNT } }],
  [{ groupId: 9 }, { project: { id: '9' } }],
  [{ deadline: '2026-04-05T23:59:00Z' }, { duedate: '2026-04-05' }],
  [{ deadline: null }, { duedate: null }],
  [{ priority: 0 }, { priority: { id: '10' } }],
  [{ priority: 1 }, { priority: { id: '11' } }],
  [{ priority: 2 }, { priority: { id: '12' } }],
]) {
  test(`Частичная правка ${Object.keys(input)[0]}: только заданное поле`, async () => {
    const { driver, calls } = fixture();

    assert.deepEqual(await driver.updateTask('42', input), { ok: true, id: 42 });
    assert.deepEqual(calls.at(-1).body, { fields });
    assert.equal(calls.at(-1).options.method, 'PUT');
    assert.equal(calls.filter((call) => call.path === '/rest/api/2/issue/42').length, 1);
  });
}

test('Приоритет без имени на сайте не отправляется, остальные поля сохраняются', async () => {
  const { driver, calls } = fixture({ respond: ({ path }) => {
    if (path.endsWith('/priority')) {
      return Response.json([{ id: '3', name: 'Особый' }]);
    }
  } });

  await driver.updateTask('42', { title: 'Имя', priority: 2 });
  assert.deepEqual(calls.at(-1).body, { fields: { summary: 'Имя' } });

  const count = calls.length;

  await driver.updateTask('42', { priority: 2 });
  assert.equal(calls.length, count + 1);
  assert.equal(calls.at(-1).path, '/rest/api/2/priority');
  await driver.createTask({
    title: 'Новая',
    groupId: 9,
    priority: 2,
  });
  assert.equal(Object.hasOwn(calls.at(-1).body.fields, 'priority'), false);
});

for (const key of ['accomplices', 'auditors']) {
  for (const value of [[ACCOUNT], [], '', null]) {
    test(`Роль ${key} отвергается явно: ${JSON.stringify(value)}`, async () => {
      const { driver, calls } = fixture();

      await assert.rejects(driver.updateTask('42', { [key]: value }), {
        code: 'b24_bad_request', message: /не поддерживает/u,
      });
      assert.equal(calls.length, 0);
    });
  }
}

test('Некорректная правка и создание отклоняются до сети', async () => {
  const { driver, calls } = fixture();

  for (const fields of [null, [], {}, { unknown: 1 }, { title: '' }, { title: undefined },
    { description: null }, { responsibleId: '' }, { responsibleId: 0 }, { responsibleId: 1.5 },
    { groupId: 'PROJ' }, { deadline: 'завтра' }, { priority: 3 }]) {
    await assert.rejects(driver.updateTask('42', fields), { code: 'b24_bad_request' });
  }

  await assert.rejects(driver.createTask({ title: 'Нет проекта' }), { code: 'b24_bad_request' });
  await assert.rejects(driver.updateTask('PROJ-42', { title: 'Имя' }), { code: 'b24_bad_request' });
  assert.equal(calls.length, 0);
});

test('Tags: замена и очистка передаются полным JSON-массивом', async () => {
  const { driver, calls } = fixture();

  for (const tags of [['Один', 'Два'], []]) {
    await driver.updateTaskTags('42', tags);
    assert.deepEqual(calls.at(-1).body, { fields: { labels: tags } });
    assert.equal(calls.at(-1).options.headers['Content-Type'], 'application/json');
  }
});

test('Добавление комментария сохраняет текст, пустой комментарий отклоняется', async () => {
  const text = '<b>Текст</b>\n[wiki]';
  const { driver, calls } = fixture({ respond: ({ path }) => {
    if (path.endsWith('/comment')) {
      return Response.json({ id: '101' }, { status: 201 });
    }
  } });

  assert.deepEqual(await driver.addComment('42', text), { ok: true, commentId: 101 });
  assert.deepEqual(calls[0].body, { body: text });
  assert.equal(calls[0].path, '/rest/api/2/issue/42/comment');
  await assert.rejects(driver.addComment('42', ' '), { code: 'b24_bad_request' });
  assert.equal(calls.length, 1);
});

for (const [action, transitions, selected] of [
  ['completeTask', [transition('1', 'indeterminate'), transition('2', 'done'), transition('3', 'done')], '2'],
  ['renewTask', [transition('1', 'to_do'), transition('2', 'indeterminate')], '2'],
  ['renewTask', [transition('1', 'done'), transition('2', 'to_do')], '2'],
  ['renewTask', [transition('1', 'done'), transition('2', 'new')], '2'],
]) {
  test(`${action} выбирает категорию назначения, переход ${selected}`, async () => {
    const { driver, calls } = fixture({ respond: ({ options }) => options.method === 'GET'
      ? Response.json({ transitions }) : new Response(null, { status: 204 }) });

    assert.deepEqual(await driver[action]('42'), { ok: true });
    assert.deepEqual(calls.at(-1).body, { transition: { id: selected } });
    assert.equal(calls.length, 2);
  });
}

for (const action of ['completeTask', 'renewTask']) {
  test(`${action}: нет перехода — понятная ошибка 400 без POST`, async () => {
    const { driver, calls } = fixture({ respond: () => Response.json({ transitions: [] }) });

    await assert.rejects(driver[action]('42'), {
      code: 'b24_bad_request',
      status: 400,
      message: /нет доступного перехода/u,
    });
    assert.equal(calls.length, 1);
  });
}
