import { Buffer } from 'node:buffer';

import { TrackerError } from '../types/contract.ts';
import type { TaskData } from '../types/contract.ts';
import type { Credentials } from './auth.ts';
import { isRecord, redactSecrets } from './objects.ts';

export type Rest = (path: string, method?: string, body?: TaskData) => Promise<unknown>;

/**
 * Транспорт закреплён за одним набором реквизитов на всё время операции.
 * Каждый запрос имеет срок 30 секунд; redirect и повторы мутаций запрещены.
 */
export function createRest(creds: Credentials, transport: typeof fetch): Rest {
  const pair = `${creds.email}:${creds.apiToken}`;
  const basic = Buffer.from(pair).toString('base64');
  const secrets = [creds.email, creds.apiToken, pair, basic];

  return async (path, method = 'GET', body) => {
    try {
      const response = await transport(`${creds.origin}${path}`, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Basic ${basic}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();

        throw new TrackerError('tracker_rest_error', 'Jira перенаправила запрос', 502);
      }

      if (response.status === 204) {
        return null;
      }

      const data: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const errors = isRecord(data) && isRecord(data.errors) ? Object.values(data.errors) : [];
        const messages = isRecord(data) && Array.isArray(data.errorMessages) ? data.errorMessages : [];
        const raw = [...messages, ...errors].filter((text) => typeof text === 'string').join('; ');
        const message = redactSecrets(raw || 'Jira отклонила запрос', secrets);
        const missing = response.status === 404 && /^\/rest\/api\/2\/issue\//u.test(path);

        throw new TrackerError(missing ? 'task_not_found' : 'tracker_rest_error', message,
          response.status);
      }

      if (data === null) {
        throw new TrackerError('tracker_rest_error', 'Некорректный ответ Jira', 502);
      }

      return data;
    } catch (error) {
      if (error instanceof TrackerError) {
        throw error;
      }

      throw new TrackerError('tracker_rest_error', 'Не удалось выполнить запрос Jira', 502);
    }
  };
}

/**
 * Только отсутствие версии REST разрешает запасное чтение.
 * Отказы авторизации, лимиты, сетевые сбои и redirect сюда не относятся.
 */
export function allowsFallback(error: unknown): boolean {
  return error instanceof TrackerError && [404, 410].includes(error.status);
}
