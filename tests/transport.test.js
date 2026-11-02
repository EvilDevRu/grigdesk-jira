import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture, TOKEN, transition } from './fixtures/jira.js';

const MUTATIONS = [
  ['createTask', [{ title: 'Новая', groupId: 9 }]],
  ['updateTask', ['42', { title: 'Имя' }]],
  ['updateTaskTags', ['42', []]],
  ['addComment', ['42', 'Текст']],
  ['completeTask', ['42']],
  ['renewTask', ['42']],
];

for (const failure of ['network', 302, 400, 401, 404, 410, 429, 503]) {
  for (const [action, args] of MUTATIONS) {
    test(`${action} после ${failure}: одна мутация без повтора`, async () => {
      const { driver, calls } = fixture({ respond: ({ options, path }) => {
        if (path.endsWith('/transitions') && options.method === 'GET') {
          return Response.json({ transitions: [transition('1', 'done'), transition('2', 'indeterminate')] });
        }

        if (options.method === 'GET') {
          return;
        }

        if (failure === 'network') {
          throw new Error(`Сеть упала: ${TOKEN}`);
        }

        return new Response(null, { status: failure, headers: { location: 'https://other.fixture' } });
      } });

      await assert.rejects(driver[action](...args), (error) => {
        assert.equal(error.message.includes(TOKEN), false);

        return true;
      });
      assert.equal(calls.filter((call) => call.options.method !== 'GET').length, 1);
    });
  }
}

for (const [status, presence] of [[404, 'absent'], [403, 'unknown'], [500, 'unknown']]) {
  test(`Наличие задачи при HTTP ${status}: ${presence}`, async () => {
    const { driver, calls } = fixture({ respond: () => new Response(null, { status }) });

    assert.equal(await driver.probeTaskNumber('42'), presence);
    assert.equal(calls.length, 1);
  });
}

test('Отсутствующая задача: task_not_found и HTTP 404', async () => {
  const { driver } = fixture({ respond: () => new Response(null, { status: 404 }) });

  await assert.rejects(driver.taskDetail('42'), { code: 'task_not_found', status: 404 });
});

test('Наличие задачи подтверждается только успешным чтением', async () => {
  const { driver } = fixture();

  assert.equal(await driver.probeTaskNumber('42'), 'exists');
});

for (const failure of ['network', 'redirect', 'bad-json']) {
  test(`Чтения при ${failure}: отказ без повтора и без секретов`, async () => {
    const { driver, calls } = fixture({ respond: () => {
      if (failure === 'network') {
        throw new Error(TOKEN);
      }

      return failure === 'redirect'
        ? new Response(null, { status: 302, headers: { location: 'https://other.fixture' } })
        : new Response('<html>вместо JSON</html>');
    } });

    assert.equal((await driver.testAuth()).ok, false);
    await assert.rejects(driver.listTasks(), (error) => {
      assert.equal(error.message.includes(TOKEN), false);

      return true;
    });
    assert.equal(await driver.probeTaskNumber('42'), 'unknown');
    assert.equal(calls.length, 3);
  });
}

test('Каждый HTTP-вызов получает таймаут ровно 30 секунд', async (t) => {
  const timeouts = [];

  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    timeouts.push(milliseconds);

    return new AbortController().signal;
  });

  const { driver } = fixture();

  await driver.testAuth();
  await driver.taskDetail('42');
  assert.deepEqual(timeouts, [30_000, 30_000]);
});
