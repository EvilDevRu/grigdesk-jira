import type { TaskTracker, TrackerHost } from './types/contract.ts';
import { createJiraTracker } from './src/client.ts';

/**
 * Точка входа использует локальный снимок контракта и переданный host-транспорт.
 * Все правила Jira остаются в пакете, без runtime-импортов ядра GrigDesk.
 */
export default function createDriver(host: TrackerHost): TaskTracker {
  return createJiraTracker(host, host.fetch);
}
