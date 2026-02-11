/// <reference path='../../typings.d.ts' />
import { Router, Request, Response } from 'express';
import * as HttpStatus from 'http-status-codes';
import { DataModel } from '../models/data';
import { DopaModel } from '../models/dopa';
import { DataMSSQLModel } from '../models/mssql';
const router: Router = Router();
const dataModel = new DataModel();
import * as _ from 'lodash';
import moment = require('moment');
import { log } from 'node:console';

export type LogColor = 'purple' | 'blue' | 'red' | 'green' | 'orange';
export type ProcessContext = {
  db: any;
  dbmssql: any;
  logMessage?: (taskId: string, message: string, color?: LogColor) => void;
  shouldContinue?: () => boolean;
};
export type ProcessResult = { ok: boolean; state: string; code: number };

let isProcessing = false;
export const isProcessRunning = () => isProcessing;

const fallbackLogMessage = (taskId: string, message: string, color: LogColor = 'blue') => {
  const prefix = color === 'red' ? '[ERROR]' : color === 'green' ? '[OK]' : '[INFO]';
  console.log(`${prefix} ${taskId} | ${message}`);
};

const getLogMessage = (ctx: ProcessContext) => ctx.logMessage ?? fallbackLogMessage;
const canContinue = (ctx: ProcessContext) => !ctx.shouldContinue || ctx.shouldContinue();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const isStopError = (error: any): error is { stopped: true } => !!error && error.stopped === true;
const convertThaiDobToIso = (dob: unknown): string | null => {
  const raw = String(dob ?? '').trim();
  if (!/^\d{8}$/.test(raw)) return null;

  const year = Number(raw.slice(0, 4)) - 543;
  const month = raw.slice(4, 6);
  const day = raw.slice(6, 8);
  return `${year}-${month}-${day}`;
};


const dataMssqlModel = new DataMSSQLModel();

const dopaModel = new DopaModel();

router.get('/state', async (req: Request, res: Response) => {
  try {
    const rs: any = await dataModel.getState(req.db);
    const logs: any = await dataModel.getLogDetails(req.db, rs[0].log_id);
    const state = rs?.length ? rs[0].state : null;
    res.send({ ok: true, isProcessing, state: state, details: logs });
  } catch (error: any) {
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

  if (isProcessing) {
    return { ok: true, state: 'Processing already running.', code: HttpStatus.OK };
  }

  if (!canContinue(ctx)) {
    return { ok: true, state: 'Stopped by schedule window.', code: HttpStatus.OK };
  }

  isProcessing = true;
  try {
    logMessage('SYS', 'เริ่มประมวลผลรายงาน', 'purple');
    const current = await getCurrentState(ctx);
    if (!current.state) {
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
      return { ok: true, state: 'Stopped by schedule window.', code: HttpStatus.OK };
    }
    // 3,4
    state = await stepCheckPop(ctx, logId, state);
    if (!canContinue(ctx)) {
      logMessage('SYS', 'หยุดตามเวลาที่กำหนด', 'orange');
      return { ok: true, state: 'Stopped by schedule window.', code: HttpStatus.OK };
    }
    // 5
    state = await stapWaitLogin(ctx, logId, state);
    if (!canContinue(ctx)) {
      logMessage('SYS', 'หยุดตามเวลาที่กำหนด', 'orange');
      return { ok: true, state: 'Stopped by schedule window.', code: HttpStatus.OK };
    }
    // 6,7
    state = await stepLK2(ctx, logId, state);
    if (!canContinue(ctx)) {
      logMessage('SYS', 'หยุดตามเวลาที่กำหนด', 'orange');
      return { ok: true, state: 'Stopped by schedule window.', code: HttpStatus.OK };
    }

    // 0 finish
    state = await done(ctx, logId, state);

    return { ok: true, state: 'Processing done.', code: HttpStatus.OK };
  } catch (error) {
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
    logMessage('ERROR', `เกิดข้อผิดพลาดในการดึงข้อมูลจากฐานข้อมูล`, 'red');
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
    runOnce: () => verifyCheckPOP(ctx.db, logDetailId, ctx.shouldContinue),
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
      res = await dopaModel.lkCheckToken(token[0].token);
    } else {

    }
    console.log('res', res);

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
    logMessage('SYS', 'หยุดตามเวลาที่กำหนด', 'orange');
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
}): Promise<{ ok: boolean; stopped: boolean }> {
  for (let retry = 0; retry < opts.maxRetry; retry++) {
    if (opts.shouldContinue && !opts.shouldContinue()) {
      return { ok: false, stopped: true };
    }
    const count = await opts.checkCount();
    if ((count?.[0]?.count ?? 0) <= 0) return { ok: true, stopped: false };

    if (retry > 0 && opts.delayMs && opts.delayMs > 0) {
      if (opts.shouldContinue && !opts.shouldContinue()) {
        return { ok: false, stopped: true };
      }
      await sleep(opts.delayMs);
    }
    if (opts.shouldContinue && !opts.shouldContinue()) {
      return { ok: false, stopped: true };
    }
    await opts.runOnce();
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
  opts: { maxRetries: number; delayMs: number; label?: string }
): Promise<{ ok: true; data: T; attempts: number } | { ok: false; error: any; attempts: number }> {
  const { maxRetries, delayMs, label } = opts;

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
  shouldContinue?: () => boolean
): Promise<{ stopped: boolean }> {
  for (const row of rows) {
    if (shouldContinue && !shouldContinue()) {
      return { stopped: true };
    }
    try {
      const result = await runner(row);
      await onSuccess(row, result);
    } catch (err) {
      if (isStopError(err)) {
        return { stopped: true };
      }
      await onFail(row, err);
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
  } = params;

  // await dataModel.setState(db, setStateStart);

  const rows: any[] = getRows ? await getRows(db) : await dataModel.getData(db);

  const result = await processEachRow(
    rows,
    async (row) => {
      if (shouldContinue && !shouldContinue()) {
        throw { stopped: true };
      }
      const r: any = await retry(() => callDopa(row), {
        maxRetries,
        delayMs: retryDelayMs,
        label,
      });

      if (!r.ok) throw r.error; // ให้ไป onFail
      if (shouldContinue && !shouldContinue()) {
        throw { stopped: true };
      }
      return r.data;
    },
    async (row, info) => {
      await updateOnSuccess(db, row, info);
    },
    async (row, error) => {
      console.error(`[${label}] failed for row`, row?.id ?? row, error);
      await updateOnFail(db, row, error);
    },
    shouldContinue
  );
  if (result.stopped) return;

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

export async function verifyCheckPOP(db: any, logDetailId: number, shouldContinue?: () => boolean) {
  return verifyWithDopa({
    db,
    setStateStart: 3,
    setStateDone: 4,
    label: 'CHECKPOP',
    getRows: async (db) => await dataModel.getDataPOPPending(db),
    callDopa: async (row) => await dopaModel.checkpop(row, shouldContinue),


    updateOnSuccess: async (db, row, info) => {

      // console.log('update', row, info);
      // เก็บ info เท่าที่อยากเก็บได้ เช่น raw response, message, ฯลฯ
      await dataModel.updateRowCheckPOP(db, logDetailId);
      await dataModel.updateData(db, row.id, {
        status_checkpop: info == null ? 'PENDING' : info,
        status: info == null ? 'PENDING' : +info == 1 ? 'DEATH' : +info == 0 ? 'ALIVE' : +info == 2 ? 'LOST' : 'PENDING',
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
      const lkStatus = info?.status;
      const lkDobIso = convertThaiDobToIso(info?.dob);
      await dataModel.updateRowCheckLK(db, logDetailId);
      await dataModel.updateData(db, row.id, {
        status_lk: lkStatus == null ? 'PENDING' : lkStatus,
        status: lkStatus == null ? 'PENDING' : +lkStatus == 1 ? 'DEATH' : +lkStatus == 0 ? 'ALIVE' : +lkStatus == 2 ? 'LOST' : 'PENDING',
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
  });
}


export default router;
