import chalk from 'chalk';
import { DataModel } from '../models/data';
import { ProcessContext, runProcess, isProcessRunning } from '../routes/process';

const cron = require('node-cron');

type ConfigDatetimeRow = {
  dd: number | string;
  mm: number | string;
  time: string;
  hour: number | string;
};

type TimeParts = { hour: number; minute: number; second: number };

type NormalizedRow = {
  dd: number;
  mm: number;
  hour: number;
  timeParts: TimeParts;
  rawTime: string;
};

const dataModel = new DataModel();

const fallbackLogMessage: ProcessContext['logMessage'] = (taskId, message, color = 'blue') => {
  const now = new Date();
  const timestamp = now.toTimeString().split(' ')[0] + `.${now.getMilliseconds().toString().padStart(3, '0')}`;
  const colorFn =
    color === 'purple'
      ? chalk.hex('#9402e8').bold
      : color === 'orange'
        ? chalk.hex('#e86202').bold
        : color === 'red'
          ? chalk.hex('#e80202').bold
          : color === 'green'
            ? chalk.hex('#00fb58ff').bold
            : chalk.hex('#7cfced').bold;
  console.log(`${timestamp} ${chalk.gray('|')} ${colorFn(taskId)} | ${message}`);
};

const parseTimeParts = (value: string): TimeParts | null => {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const normalized = raw.startsWith(':') ? raw.slice(1) : raw;
  const parts = normalized.split(':');
  if (parts.length < 2) return null;
  const [h, m, s = '0'] = parts;
  const hour = Number(h);
  const minute = Number(m);
  const second = Number(s);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(second)) return null;
  return { hour, minute, second };
};

const normalizeRow = (row: ConfigDatetimeRow): NormalizedRow | null => {
  const dd = Number(row.dd);
  const mm = Number(row.mm);
  const hour = Number(row.hour);
  if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(hour)) return null;
  if (dd <= 0 || dd > 31 || mm <= 0 || mm > 12 || hour <= 0) return null;
  const rawTime = String(row.time ?? '').trim();
  const timeParts = parseTimeParts(rawTime);
  if (!timeParts) return null;
  return { dd, mm, hour, timeParts, rawTime };
};

const isSameDate = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const isValidDate = (date: Date, dd: number, mm: number) =>
  date.getFullYear() > 0 && date.getMonth() === mm - 1 && date.getDate() === dd;

const buildStartDate = (baseDate: Date, timeParts: TimeParts) =>
  new Date(
    baseDate.getFullYear(),
    baseDate.getMonth(),
    baseDate.getDate(),
    timeParts.hour,
    timeParts.minute,
    timeParts.second,
    0
  );

const isWithinWindow = (now: Date, startDate: Date, timeParts: TimeParts, durationHours: number) => {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

  const todayStart = buildStartDate(today, timeParts);
  const todayEnd = new Date(todayStart.getTime() + durationHours * 60 * 60 * 1000);
  if (todayStart >= startDate && now >= todayStart && now <= todayEnd) return true;

  const yesterdayStart = buildStartDate(yesterday, timeParts);
  const yesterdayEnd = new Date(yesterdayStart.getTime() + durationHours * 60 * 60 * 1000);
  if (yesterdayStart >= startDate && now >= yesterdayStart && now <= yesterdayEnd) return true;

  return false;
};

const makeDateKey = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const makeScheduleKey = (row: NormalizedRow) =>
  `${row.dd}-${row.mm}-${row.timeParts.hour}:${row.timeParts.minute}:${row.timeParts.second}-${row.hour}`;

export function startScheduler(baseCtx: { db: any; dbmssql: any; logMessage?: ProcessContext['logMessage'] }) {
  const logMessage = baseCtx.logMessage ?? fallbackLogMessage;
  const lastRunByKey = new Map<string, string>();
  let tickRunning = false;

  const tick = async () => {
    if (tickRunning) return;
    tickRunning = true;
    try {
      const rows: ConfigDatetimeRow[] = await dataModel.getConfigDatetime(baseCtx.db);
      if (!rows?.length) return;

      const stateRow: any = await dataModel.getState(baseCtx.db);
      const state = Number(stateRow?.[0]?.state ?? 0);
      const isDone = state === 8;
      const now = new Date();

      const normalizedRows = rows
        .map(normalizeRow)
        .filter((row): row is NormalizedRow => row !== null)
        .sort((a, b) => {
          if (a.mm !== b.mm) return a.mm - b.mm;
          if (a.dd !== b.dd) return a.dd - b.dd;
          if (a.timeParts.hour !== b.timeParts.hour) return a.timeParts.hour - b.timeParts.hour;
          if (a.timeParts.minute !== b.timeParts.minute) return a.timeParts.minute - b.timeParts.minute;
          return a.timeParts.second - b.timeParts.second;
        });

      for (const row of normalizedRows) {
        const startDate = new Date(now.getFullYear(), row.mm - 1, row.dd);
        if (!isValidDate(startDate, row.dd, row.mm)) continue;
        if (now < startDate) continue;

        const withinWindow = isWithinWindow(now, startDate, row.timeParts, row.hour);
        if (!withinWindow) continue;

        const isStartDay = isSameDate(now, startDate);
        if (isDone && !isStartDay) continue;

        const scheduleKey = makeScheduleKey(row);
        const todayKey = makeDateKey(now);
        if (isDone && lastRunByKey.get(scheduleKey) === todayKey) continue;

        if (isProcessRunning()) {
          logMessage('CRON', 'Process already running. Skip this tick.', 'orange');
          return;
        }

        lastRunByKey.set(scheduleKey, todayKey);
        logMessage(
          'CRON',
          `Trigger process for ${String(row.dd).padStart(2, '0')}/${String(row.mm).padStart(2, '0')} at ${row.rawTime} for ${row.hour}h`,
          'purple'
        );

        const shouldContinue = () => isWithinWindow(new Date(), startDate, row.timeParts, row.hour);
        const result = await runProcess({
          db: baseCtx.db,
          dbmssql: baseCtx.dbmssql,
          logMessage,
          shouldContinue,
        });

        if (!result.ok) {
          logMessage('CRON', `Process error: ${result.state}`, 'red');
        }
        return;
      }
    } catch (error: any) {
      logMessage('CRON', `Scheduler error: ${error?.message ?? error}`, 'red');
    } finally {
      tickRunning = false;
    }
  };

  cron.schedule('* * * * *', () => {
    void tick();
  });

  setTimeout(() => {
    void tick();
  }, 5000);
}
