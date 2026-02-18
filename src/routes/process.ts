/// <reference path='../../typings.d.ts' />
import { Router, Request, Response } from 'express';
import * as HttpStatus from 'http-status-codes';
import { DataModel } from '../models/data';
import { DopaModel } from '../models/dopa';
import { DataMSSQLModel } from '../models/mssql';
import { exportReports } from '../jobs/exporter';
import * as _ from 'lodash';
const router: Router = Router();
const dataModel = new DataModel();

const dataMssqlModel = new DataMSSQLModel();

const dopaModel = new DopaModel();

export type LogColor = 'purple' | 'blue' | 'red' | 'green' | 'orange';
export type ProcessContext = {
  db: any;
  dbmssql: any;
  logMessage?: (taskId: string, message: string, color?: LogColor) => void;
  shouldContinue?: () => boolean;
  allowAlreadyRunning?: boolean;
};
export type ProcessResult = { ok: boolean; state: string; code: number };

let isProcessing = false;
export const isProcessRunning = () => isProcessing;
export const setProcessRunning = (value: boolean) => {
  isProcessing = value;
};

const fallbackLogMessage = (taskId: string, message: string, color: LogColor = 'blue') => {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const timestamp = `${date} ${now.toTimeString().split(' ')[0]}.${now.getMilliseconds().toString().padStart(3, '0')}`;
  const prefix = color === 'red' ? '[ERROR]' : color === 'green' ? '[OK]' : '[INFO]';
  console.log(`${timestamp} ${prefix} ${taskId} | ${message}`);
};

const getLogMessage = (ctx: ProcessContext) => ctx.logMessage ?? fallbackLogMessage;
const canContinue = (ctx: ProcessContext) => !ctx.shouldContinue || ctx.shouldContinue();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const sleepWithCheck = async (ms: number, shouldContinue?: () => boolean) => {
  const stepMs = 1000;
  let remaining = ms;
  while (remaining > 0) {
    if (shouldContinue && !shouldContinue()) {
      return false;
    }
    const wait = Math.min(stepMs, remaining);
    await sleep(wait);
    remaining -= wait;
  }
  return true;
};
const isStopError = (error: any): error is { stopped: true; reason?: string } => !!error && error.stopped === true;
const convertThaiDobToIso = (dob: unknown): string | null => {
  const raw = String(dob ?? '').trim();
  if (!/^\d{8}$/.test(raw)) return null;

  const year = Number(raw.slice(0, 4)) - 543;
  const month = raw.slice(4, 6);
  const day = raw.slice(6, 8);
  return `${year}-${month}-${day}`;
};

type ConfigDatetimeRow = {
  dd: number | string;
  mm: number | string;
  time: string;
  hour: number | string;
};

type TimeParts = { hour: number; minute: number; second: number };

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

const normalizeScheduleRow = (row: ConfigDatetimeRow) => {
  const dd = Number(row.dd);
  const mm = Number(row.mm);
  const hours = Number(row.hour);
  if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(hours)) return null;
  if (dd <= 0 || dd > 31 || mm <= 0 || mm > 12 || hours <= 0) return null;
  const timeParts = parseTimeParts(String(row.time ?? ''));
  if (!timeParts) return null;
  return { dd, mm, hours, timeParts };
};

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

const getScheduleStatus = (rows: ConfigDatetimeRow[], now: Date) => {
  const normalizedRows = rows
    .map(normalizeScheduleRow)
    .filter((row): row is { dd: number; mm: number; hours: number; timeParts: TimeParts } => row !== null);
  const exists = normalizedRows.length > 0;
  const isWithin = normalizedRows.some((row) => {
    const startDate = new Date(now.getFullYear(), row.mm - 1, row.dd);
    if (!isValidDate(startDate, row.dd, row.mm)) return false;
    if (now < startDate) return false;
    return isWithinWindow(now, startDate, row.timeParts, row.hours);
  });
  return { exists, isWithin };
};


router.get('/state', async (req: Request, res: Response) => {
  try {
    const rs: any = await dataModel.getState(req.db);
    const logs: any = await dataModel.getLogDetails(req.db, rs[0].log_id);
    const state = rs?.length ? rs[0].state : null;
    const scheduleRows: ConfigDatetimeRow[] = await dataModel.getConfigDatetime(req.db);
    const scheduleStatus = getScheduleStatus(scheduleRows ?? [], new Date());

    const stateValue = state === null || state === undefined ? null : Number(state);
    const isDone = stateValue === 8;
    const isIdle = stateValue === 0 || stateValue === null || Number.isNaN(stateValue);

    let statusText = 'stopped_unexpected';
    if (isProcessing) {
      statusText = 'running';
    } else if (isDone) {
      statusText = 'done';
    } else if (isIdle) {
      statusText = 'idle';
    } else if (scheduleStatus.exists && !scheduleStatus.isWithin) {
      statusText = 'paused_by_schedule';
    }

    res.send({ ok: true, isProcessing, state: state, statusText, details: logs });
  } catch (error: any) {
    const message = error?.message ?? error;
    req.logMessage?.('ERROR', `Process state error: ${message}`, 'red');
    res.send({ ok: false, error: error?.message ?? error, code: HttpStatus.INTERNAL_SERVER_ERROR });
  }
});


router.get('/', async (req: Request, res: Response) => {
  const result = await runProcess({
    db: req.db,
    dbmssql: req.dbmssql,
    logMessage: req.logMessage,
  });
  return res.send(result);
});

export async function runProcess(ctx: ProcessContext): Promise<ProcessResult> {
  const logMessage = getLogMessage(ctx);
  const stopProcessing = () => setProcessRunning(false);

  if (isProcessing && !ctx.allowAlreadyRunning) {
    return { ok: true, state: 'Processing already running.', code: HttpStatus.OK };
  }

  if (!canContinue(ctx)) {
    stopProcessing();
    return { ok: true, state: 'Stopped by schedule window.', code: HttpStatus.OK };
  }

  isProcessing = true;
  try {
    logMessage('SYS', 'เริ่มประมวลผลรายงาน', 'purple');
    const current = await getCurrentState(ctx);
    if (!current.state) {
      stopProcessing();
      return { ok: true, state: 'No state found.', code: HttpStatus.OK };
    }
    let logId;
    if (+current.state === 8 || +current.state === 0) {
      const _logId = await dataModel.saveLogs(ctx.db);
      logId = _logId[0];
    } else {
      logId = current.log_id;
    }
    logMessage('SYS', `State ปัจจุบัน = ${current.state}`, 'purple');
    let state = +current.state;
    // 1,2
    state = await stepPullData(ctx, logId, state);
    if (!canContinue(ctx)) {
      logMessage('SYS', 'หยุดตามเวลาที่กำหนด', 'orange');
      stopProcessing();
      return { ok: true, state: 'Stopped by schedule window.', code: HttpStatus.OK };
    }
    // 3,4
    state = await stepCheckPop(ctx, logId, state);
    if (!canContinue(ctx)) {
      logMessage('SYS', 'หยุดตามเวลาที่กำหนด', 'orange');
      stopProcessing();
      return { ok: true, state: 'Stopped by schedule window.', code: HttpStatus.OK };
    }
    // 5
    state = await stapWaitLogin(ctx, logId, state);
    if (!canContinue(ctx)) {
      logMessage('SYS', 'หยุดตามเวลาที่กำหนด', 'orange');
      stopProcessing();
      return { ok: true, state: 'Stopped by schedule window.', code: HttpStatus.OK };
    }
    // 6,7
    state = await stepLK2(ctx, logId, state);
    if (!canContinue(ctx)) {
      logMessage('SYS', 'หยุดตามเวลาที่กำหนด', 'orange');
      stopProcessing();
      return { ok: true, state: 'Stopped by schedule window.', code: HttpStatus.OK };
    }

    // 0 finish
    state = await done(ctx, logId, state);

    if (state === 8) {
      await exportReports(ctx.db, logId, logMessage);
    }

    return { ok: true, state: 'Processing done.', code: HttpStatus.OK };
  } catch (error) {
    const message = (error as any)?.message ?? error;
    logMessage('ERROR', `Processing error: ${message}`, 'red');
    stopProcessing();
    return { ok: false, state: 'Processing error.', code: HttpStatus.INTERNAL_SERVER_ERROR };
  } finally {
    isProcessing = false;
  }
}

async function getCurrentState(ctx: ProcessContext): Promise<any | null> {
  const rs: any = await dataModel.getState(ctx.db);
  return rs?.length ? rs[0] : {};
}

async function stepPullData(ctx: ProcessContext, logId: number, state: number): Promise<number> {
  if (!(state === 0 || state === 1 || state === 8)) return state;

  try {
    const logMessage = getLogMessage(ctx);
    logMessage('SYS', `เริ่มดึงข้อมูลจากฐานข้อมูล`, 'purple');
    await setState(ctx, logId, 1);
    const row = await pullData(ctx.db, logId, ctx.dbmssql);
    await setState(ctx, logId, 2, row);
    logMessage('SYS', `ดึงข้อมูลจากฐานข้อมูลสำเร็จ`, 'green');
    return 2;
  } catch (err) {
    console.log(err);
    const logMessage = getLogMessage(ctx);
    const message = (err as any)?.message ?? err;
    logMessage('ERROR', `เกิดข้อผิดพลาดในการดึงข้อมูลจากฐานข้อมูล: ${message}`, 'red');
    await markError(ctx, 'PULLDATA', err);
    return state;
  }
}

async function stepCheckPop(ctx: ProcessContext, logId: number, state: number): Promise<number> {
  if (!(state === 2 || state === 3)) return state;

  const logMessage = getLogMessage(ctx);
  const logDetailId = await setState(ctx, logId, 3);
  logMessage('SYS', `เริ่มตรวจสอบข้อมูลกับ checkpop`, 'purple');
  const result = await retryUntilDone({
    maxRetry: 5,
    checkCount: () => dataModel.checkDataPOPDone(ctx.db),
    runOnce: () => verifyCheckPOP(ctx.db, logDetailId, getLogMessage(ctx), ctx.shouldContinue),
    shouldContinue: ctx.shouldContinue,
  });

  if (result.stopped) {
    logMessage('SYS', 'หยุดตามเวลาที่กำหนด', 'orange');
    return state;
  }
  if (!result.ok) {
    console.log(result);
    await markError(ctx, 'CHECKPOP');
    logMessage('ERROR', `เกิดข้อผิดพลาดในการตรวจสอบข้อมูลกับ checkpop`, 'red');
    return state;
  }
  logMessage('SYS', `ตรวจสอบข้อมูลกับ checkpop สำเร็จ`, 'green');
  await setState(ctx, logId, 4);
  return 4;
}

async function stapWaitLogin(ctx: ProcessContext, logId: number, state: number): Promise<number> {
  if (!(state === 4 || state === 5)) return state;

  // await setState(req, 6);
  const logMessage = getLogMessage(ctx);
  logMessage('SYS', `รอ Login ThaiD`, 'purple');
  let res;
  let pass = false;
  do {
    if (!canContinue(ctx)) {
      logMessage('SYS', 'หยุดตามเวลาที่กำหนด', 'orange');
      return state;
    }
    const token = await dataModel.getTokenLK(ctx.db);
    if (token.length) {
      res = await dopaModel.lkCheckToken(token[0].token, logMessage);
    } else {

    }
    // console.log('res', res);

    if (res) {
      pass = true;
    }
    await sleep(3000);
  } while (!pass);
  // await setState(req, logId, 6);
  logMessage('SYS', `Login ThaiD สำเร็จ`, 'green');
  return 6;
}
async function stepLK2(ctx: ProcessContext, logId: number, state: number): Promise<number> {
  if (!(state === 6 || state === 7)) return state;

  const logMessage = getLogMessage(ctx);
  const logDetailId = await setState(ctx, logId, 6);
  logMessage('SYS', `เริ่มตรวจสอบข้อมูลกับ LK2`, 'purple');
  const result = await retryUntilDone({
    maxRetry: 5,
    checkCount: () => dataModel.checkDataLKDone(ctx.db),
    runOnce: () => verifyLK2(ctx.db, logDetailId, getLogMessage(ctx), ctx.shouldContinue),
    delayMs: 60 * 1000,
    shouldContinue: ctx.shouldContinue,
  });

  if (result.stopped) {
    if (result.reason === 'LK_403') {
      logMessage('SYS', 'หยุดชั่วคราว: LK2 ตอบกลับ 403', 'orange');
    } else {
      logMessage('SYS', 'หยุดตามเวลาที่กำหนด', 'orange');
    }
    return state;
  }
  if (!result.ok) {
    await markError(ctx, 'LK2');
    logMessage('ERROR', `เกิดข้อผิดพลาดในการตรวจสอบข้อมูลกับ LK2`, 'red');
    return state;
  }

  await setState(ctx, logId, 7);
  logMessage('SYS', `ตรวจสอบข้อมูลกับ LK2 สำเร็จ`, 'green');
  return 7;
}

async function done(ctx: ProcessContext, logId: number, state: number): Promise<number> {
  if (!(state === 7)) return state;

  await setState(ctx, logId, 8);
  const logMessage = getLogMessage(ctx);
  logMessage('SYS', `ประมวลผลสำเร็จ`, 'purple');
  return 8;
}

/** helper: retry ทำซ้ำจน count=0 หรือครบ maxRetry */
async function retryUntilDone(opts: {
  maxRetry: number;
  checkCount: () => Promise<any>;
  runOnce: () => Promise<void>;
  delayMs?: number;
  shouldContinue?: () => boolean;
}): Promise<{ ok: boolean; stopped: boolean; reason?: string }> {
  for (let retry = 0; retry < opts.maxRetry; retry++) {
    if (opts.shouldContinue && !opts.shouldContinue()) {
      return { ok: false, stopped: true, reason: 'SCHEDULE' };
    }
    const count = await opts.checkCount();
    if ((count?.[0]?.count ?? 0) <= 0) return { ok: true, stopped: false };

    if (retry > 0 && opts.delayMs && opts.delayMs > 0) {
      if (opts.shouldContinue && !opts.shouldContinue()) {
        return { ok: false, stopped: true, reason: 'SCHEDULE' };
      }
      await sleep(opts.delayMs);
    }
    if (opts.shouldContinue && !opts.shouldContinue()) {
      return { ok: false, stopped: true, reason: 'SCHEDULE' };
    }
    try {
      await opts.runOnce();
    } catch (error) {
      if (isStopError(error)) {
        return { ok: false, stopped: true, reason: error.reason };
      }
      throw error;
    }
  }
  // ครบ maxRetry แล้วยังไม่เสร็จ
  return { ok: false, stopped: false };
}

/** ตัวอย่าง: เซฟ state ลง DB ให้ชัดเจน */
async function setState(ctx: ProcessContext, logId: number, state: number, count: any = null) {
  // TODO: implement dataModel.updateState(req.db, state)
  await dataModel.updateLogs(ctx.db, logId, state);
  await dataModel.setState(ctx.db, logId, state);
  const logdetailid = await dataModel.saveLogDetails(ctx.db, logId, state, count);
  return logdetailid[0];
}

async function updateLogDetails(ctx: ProcessContext, logDetailId: number, rows: any) {
  await dataModel.updateLogDetails(ctx.db, logDetailId, { rows: rows });
}
/** ตัวอย่าง: mark error แบบรวมศูนย์ */
async function markError(ctx: ProcessContext, step: string, err?: any) {
  // TODO: implement log + update error state in DB
  // await dataModel.markError(req.db, step, err?.message ?? null);
}


// -------------------- helpers --------------------
async function retry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries: number; delayMs: number; label?: string; logMessage?: (taskId: string, message: string, color?: LogColor) => void }
): Promise<{ ok: true; data: T; attempts: number } | { ok: false; error: any; attempts: number }> {
  const { maxRetries, delayMs, label, logMessage } = opts;

  let attempts = 0;
  while (true) {
    try {
      const data = await fn();
      return { ok: true, data, attempts };
    } catch (error) {
      if (isStopError(error)) {
        return { ok: false, error, attempts };
      }
      const prefix = label ? `[${label}]` : '[RETRY]';
      const message = (error as any)?.message ?? error;
      console.warn(`${prefix} error:`, message);
      const stack = (error as any)?.stack;
      if (stack) console.warn(`${prefix} stack:`, stack);
      if (logMessage) {
        logMessage(label ?? 'RETRY', `Error: ${message}`, 'red');
      }
      if (attempts >= maxRetries) {
        return { ok: false, error, attempts };
      }
      attempts++;
      if (label) console.warn(`[${label}] retry ${attempts}/${maxRetries}...`);
      await sleep(delayMs);
    }
  }
}

/** วนทีละ row + call runner + update result */
async function processEachRow<T>(
  rows: any[],
  runner: (row: any) => Promise<T>,
  onSuccess: (row: any, result: T) => Promise<void>,
  onFail: (row: any, error: any) => Promise<void>,
  shouldContinue?: () => boolean,
  delayOnFailMs?: number
): Promise<{ stopped: boolean; reason?: string }> {
  for (const row of rows) {
    if (shouldContinue && !shouldContinue()) {
      return { stopped: true, reason: 'SCHEDULE' };
    }
    try {
      const result = await runner(row);
      await onSuccess(row, result);
    } catch (err) {
      if (isStopError(err)) {
        return { stopped: true, reason: err.reason };
      }
      await onFail(row, err);
      if (delayOnFailMs && delayOnFailMs > 0) {
        const ok = await sleepWithCheck(delayOnFailMs, shouldContinue);
        if (!ok) return { stopped: true, reason: 'SCHEDULE' };
      }
    }
  }
  return { stopped: false };
}

/** แม่แบบ verify สำหรับ dopa (checkpop/lk2) */
async function verifyWithDopa<T>(params: {
  db: any;
  setStateStart: number; // 3 หรือ 5
  setStateDone: number;  // 4 หรือ 6
  label: 'CHECKPOP' | 'LK2';
  getRows?: (db: any) => Promise<any[]>;
  callDopa: (row: any) => Promise<T>;
  updateOnSuccess: (db: any, row: any, info: T) => Promise<void>;
  updateOnFail: (db: any, row: any, error: any) => Promise<void>;
  maxRetries?: number;
  retryDelayMs?: number;
  shouldContinue?: () => boolean;
  logMessage?: (taskId: string, message: string, color?: LogColor) => void;
  delayOnFailMs?: number;
}) {
  const {
    db,
    setStateStart,
    setStateDone,
    label,
    getRows,
    callDopa,
    updateOnSuccess,
    updateOnFail,
    maxRetries = 3,
    retryDelayMs = 60 * 1000,
    shouldContinue,
    logMessage,
    delayOnFailMs,
  } = params;

  // await dataModel.setState(db, setStateStart);

  const rows: any[] = getRows ? await getRows(db) : await dataModel.getData(db);

  const result = await processEachRow(
    rows,
    async (row) => {
      if (shouldContinue && !shouldContinue()) {
        throw { stopped: true, reason: 'SCHEDULE' };
      }
      const r: any = await retry(() => callDopa(row), {
        maxRetries,
        delayMs: retryDelayMs,
        label,
        logMessage,
      });

      if (!r.ok) throw r.error; // ให้ไป onFail
      if (shouldContinue && !shouldContinue()) {
        throw { stopped: true, reason: 'SCHEDULE' };
      }
      return r.data;
    },
    async (row, info) => {
      await updateOnSuccess(db, row, info);
    },
    async (row, error) => {
      console.error(`[${label}] failed for row`, row?.id ?? row, error);
      if (logMessage) {
        const message = (error as any)?.message ?? error;
        logMessage('ERROR', `[${label}] failed for row ${row?.id ?? row}: ${message}`, 'red');
      }
      await updateOnFail(db, row, error);
    },
    shouldContinue,
    delayOnFailMs
  );
  if (result.stopped) {
    throw { stopped: true, reason: result.reason };
  }

  // await dataModel.setState(db, setStateDone);
}

// -------------------- functions --------------------
export async function pullData(db: any, logId: number, dbmssql: any) {
  // await dataModel.setState(db, 1);

  const data: any[] = await dataMssqlModel.getData(dbmssql);

  await dataModel.removeData(db);

  const dataSave = _.map(data, (item: any) => ({
    cid: item.cid,
    birth_date: item.birth_date,
    member_code: item.member_code,
    status_checkpop: item.birth_date ? 'PENDING' : 'x',
  }));

  await dataModel.saveData(db, dataSave);
  return dataSave.length
  // await dataModel.setState(db, 2);
}

export async function verifyCheckPOP(
  db: any,
  logDetailId: number,
  logMessage?: (taskId: string, message: string, color?: LogColor) => void,
  shouldContinue?: () => boolean
) {
  return verifyWithDopa({
    db,
    setStateStart: 3,
    setStateDone: 4,
    label: 'CHECKPOP',
    getRows: async (db) => await dataModel.getDataPOPPending(db),
    callDopa: async (row) => await dopaModel.checkpop(row, logMessage, shouldContinue),


    updateOnSuccess: async (db, row, info) => {

      // console.log('update', row, info);
      // เก็บ info เท่าที่อยากเก็บได้ เช่น raw response, message, ฯลฯ
      await dataModel.updateRowCheckPOP(db, logDetailId);
      await dataModel.updateData(db, row.id, {
        status_checkpop: info == null ? 'PENDING' : info,
        status: info == null ? 'PENDING' : info == 'NOTFOUND' ? 'NOTFOUND' : +info == 1 ? 'DEATH' : +info == 0 ? 'ALIVE' : +info == 2 ? 'LOST' : 'PENDING',
        // checkpop_info: JSON.stringify(info),  // ถ้าอยากเก็บ
        // checkpop_updated_at: new Date(),
      });
    },

    updateOnFail: async (db, row, error) => {
      await dataModel.updateData(db, row.id, {
        status_checkpop: 'FAILED',
      });
    },

    maxRetries: 3,
    retryDelayMs: 60 * 1000,
    shouldContinue,
    logMessage,
    delayOnFailMs: 5000,
  });
}

export async function verifyLK2(
  db: any,
  logDetailId: number,
  logMessage?: (taskId: string, message: string, color?: LogColor) => void,
  shouldContinue?: () => boolean
) {
  return verifyWithDopa({
    db,
    setStateStart: 5,
    setStateDone: 6,
    label: 'LK2',
    getRows: async (db) => await dataModel.getDataLKPending(db),
    callDopa: async (row) => await dopaModel.checklk2(db, row, logMessage, shouldContinue),

    updateOnSuccess: async (db, row, info: any) => {
      // console.log(row, info);
      const lkStatus = info?.status;
      const lkDobIso = convertThaiDobToIso(info?.dob);
      await dataModel.updateRowCheckLK(db, logDetailId);
      await dataModel.updateData(db, row.id, {
        status_lk: lkStatus == null ? 'PENDING' : lkStatus,
        status: lkStatus == null ? 'PENDING' : +lkStatus == 1 ? 'DEATH' : +lkStatus == 0 ? 'ALIVE' : +lkStatus == 2 ? 'LOST' : lkStatus == 'NOTFOUND' ? 'NOTFOUND' : 'PENDING',
        birth_date: lkDobIso ?? row.birth_date,
        // lk2_info: JSON.stringify(info),
        // lk2_updated_at: new Date(),
      });
    },

    updateOnFail: async (db, row, error) => {
      console.log(error);

      await dataModel.updateData(db, row.id, {
        status_lk: 'FAILED',
        // lk2_error: String(error?.message ?? error),
        // lk2_updated_at: new Date(),
      });
    },

    maxRetries: 3,
    retryDelayMs: 60 * 1000,
    shouldContinue,
    logMessage,
    delayOnFailMs: 5000,
  });
}


export default router;
