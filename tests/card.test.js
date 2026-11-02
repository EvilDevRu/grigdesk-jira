import assert from 'node:assert/strict';
import test from 'node:test';

import { ACCOUNT, fixture, issue } from './fixtures/jira.js';

test('Карточка: числовой id, key, plain text, срок, автор, исполнитель, labels и parentId', async () => {
  const { driver, calls } = fixture();
  const detail = await driver.taskDetail('42');

  assert.deepEqual(detail, {
    id: 42,
    key: 'PROJ-42',
    title: 'Задача Jira',
    description: '&lt;b&gt;Обычный текст&lt;/b&gt;\n[без wiki|ссылка]',
    deadline: '2000-01-02T00:00:00.000Z',
    creator: { id: 'creator:9', name: 'Автор' },
    responsible: { id: ACCOUNT, name: 'Исполнитель' },
    group: { id: 9, name: 'Проект' },
    priority: 2,
    status: '10001',
    statusKind: 'in_progress',
    statusText: 'В работе',
    statusLabel: 'В работе',
    overdue: true,
    parentId: 12,
    tags: ['метка', 'label'],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/rest/api/2/issue/42');
  assert.equal(await driver.sourceUrl('42'), 'https://jira.fixture/browse/PROJ-42');
});

test('Описание экранирует буквальные HTML и entities для текстового показа', async () => {
  const { driver } = fixture({ respond: () => Response.json(issue('42', {
    description: '<script>"текст"</script> &lt;b&gt; &#60; & значение',
  })) });

  assert.equal((await driver.taskDetail('42')).description,
    '&lt;script&gt;&quot;текст&quot;&lt;/script&gt; &#38;lt;b&#38;gt; &#38;#60; &#38; значение');
});

test('PageData читает все комментарии и показывает labels и подзадачи', async () => {
  const { driver, calls } = fixture({ respond: ({ path, query }) => {
    if (!path.endsWith('/comment')) {
      return;
    }

    const page = Number(query.get('startAt'));

    return Response.json({
      startAt: page,
      maxResults: 1,
      total: 2,
      comments: [{
        id: String(100 + page),
        author: { accountId: ACCOUNT, displayName: 'Исполнитель' },
        created: '2026-01-02T03:04:05.000+0700',
        body: `<текст ${page}>\n[wiki]`,
      }],
    });
  } });
  const page = await driver.taskPageData('42');

  assert.deepEqual(page.comments, [0, 1].map((index) => ({
    id: 100 + index,
    authorId: ACCOUNT,
    author: 'Исполнитель',
    time: '2026-01-02T03:04:05.000+0700',
    text: `<текст ${index}>\n[wiki]`,
    isSystem: false,
    unread: false,
    attachments: [],
  })));
  assert.deepEqual(page.tags, ['метка', 'label']);
  assert.deepEqual(page.subtasks, [{
    id: 43,
    title: 'Подзадача',
    statusText: 'Готово',
  }]);
  assert.deepEqual(page.attachments, []);
  assert.deepEqual(calls.filter((call) => call.path.endsWith('/comment'))
    .map((call) => call.query.get('startAt')), ['0', '1']);
});

test('Пустое обсуждение и отсутствующие необязательные поля остаются пустыми', async () => {
  const { driver } = fixture({ respond: ({ path }) => path.endsWith('/comment')
    ? Response.json({
      startAt: 0,
      total: 0,
      comments: [],
    }) : Response.json(issue('42', {
        assignee: null,
        creator: null,
        parent: null,
        labels: [],
        subtasks: [],
        duedate: null,
      })) });
  const detail = await driver.taskDetail('42');
  const page = await driver.taskPageData('42');

  assert.equal(detail.responsible, null);
  assert.equal(detail.creator, null);
  assert.equal(detail.parentId, null);
  assert.equal(detail.deadline, null);
  assert.deepEqual(page, {
    comments: [],
    attachments: [],
    tags: [],
    subtasks: [],
  });
});

for (const [name, expected] of [
  ['Lowest', 0], ['Low', 0], ['Medium', 1], ['Normal', 1], ['High', 2],
  ['Highest', 2], ['Critical', 2], ['Особый', 1],
]) {
  test(`Приоритет ${name} читается как ${expected}`, async () => {
    const { driver } = fixture({ respond: () => Response.json(issue('42', { priority: { name } })) });

    assert.equal((await driver.taskDetail('42')).priority, expected);
  });
}

test('Справочники: строковые accountId и все страницы числовых проектов', async () => {
  const { driver, calls } = fixture({ respond: ({ path, query }) => {
    if (path.endsWith('/users/search')) {
      assert.equal(query.get('query'), 'Имя & знак');

      return Response.json([{ accountId: ACCOUNT, displayName: 'Имя' }]);
    }

    const index = Number(query.get('startAt'));

    return Response.json({
      startAt: index,
      isLast: index === 1,
      values: [
      { id: String(9 + index), name: `Проект ${index}` },
    ],
    });
  } });

  assert.deepEqual(await driver.findUsers('Имя & знак'), [{ id: ACCOUNT, name: 'Имя' }]);
  assert.deepEqual(await driver.listGroups(), [{ id: 9, name: 'Проект 0' }, { id: 10, name: 'Проект 1' }]);
  assert.equal(calls.length, 3);
});
