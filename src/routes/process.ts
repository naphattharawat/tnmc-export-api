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

let isProcessing = false;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
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
  try {
    isProcessing = true;
    req.logMessage('SYS', 'เริ่มประมวลผลรายงาน', 'purple');
    const current = await getCurrentState(req);
    if (!current.state) {
      return res.send({ ok: true, state: 'No state found.', code: HttpStatus.OK });
    }
    let logId;
    if (+current.state === 8 || +current.state === 0) {
      const _logId = await dataModel.saveLogs(req.db);
      logId = _logId[0];
    } else {
      logId = current.log_id;
    }
    req.logMessage('SYS', `State ปัจจุบัน = ${current.state}`, 'purple');
    let state = +current.state;
    // 1,2
    state = await stepPullData(req, logId, state);
    // 3,4
    state = await stepCheckPop(req, logId, state);
    // 5
    state = await stapWaitLogin(req, logId, state);
    // 6,7
    state = await stepLK2(req, logId, state);

    // 0 finish
    state = await done(req, logId, state);

    isProcessing = false;
    return res.send({ ok: true, state: 'Processing done.', code: HttpStatus.OK });
  } catch (error) {
    isProcessing = false;
    return res.send({ ok: false, state: 'Processing error.', code: HttpStatus.INTERNAL_SERVER_ERROR });
  } finally {
    isProcessing = false;
  }
});

async function getCurrentState(req: Request): Promise<any | null> {
  const rs: any = await dataModel.getState(req.db);
  return rs?.length ? rs[0] : {};
}

async function stepPullData(req: Request, logId: number, state: number): Promise<number> {
  if (!(state === 0 || state === 1 || state === 8)) return state;

  try {
    req.logMessage('SYS', `เริ่มดึงข้อมูลจากฐานข้อมูล`, 'purple');
    await setState(req, logId, 1);
    const row = await pullData(req.db, logId, req.dbmssql);
    await setState(req, logId, 2, row);
    req.logMessage('SYS', `ดึงข้อมูลจากฐานข้อมูลสำเร็จ`, 'green');
    return 2;
  } catch (err) {
    console.log(err);
    req.logMessage('ERROR', `เกิดข้อผิดพลาดในการดึงข้อมูลจากฐานข้อมูล`, 'red');
    await markError(req, 'PULLDATA', err);
    return state;
  }
}

async function stepCheckPop(req: Request, logId: number, state: number): Promise<number> {
  if (!(state === 2 || state === 3)) return state;

  const logDetailId = await setState(req, logId, 3);
  req.logMessage('SYS', `เริ่มตรวจสอบข้อมูลกับ checkpop`, 'purple');
  const ok = await retryUntilDone({
    maxRetry: 5,
    checkCount: () => dataModel.checkDataPOPDone(req.db),
    runOnce: () => verifyCheckPOP(req.db, logDetailId),
  });

  if (!ok) {
    await markError(req, 'CHECKPOP');
    req.logMessage('ERROR', `เกิดข้อผิดพลาดในการตรวจสอบข้อมูลกับ checkpop`, 'red');
    return state;
  }
  req.logMessage('SYS', `ตรวจสอบข้อมูลกับ checkpop สำเร็จ`, 'green');
  await setState(req, logId, 4);
  return 4;
}

async function stapWaitLogin(req: Request, logId: number, state: number): Promise<number> {
  if (!(state === 4 || state === 5)) return state;

  // await setState(req, 6);
  req.logMessage('SYS', `รอ Login ThaiD`, 'purple');
  let res;
  let pass = false;
  do {
    const token = await dataModel.getTokenLK(req.db);
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
  req.logMessage('SYS', `Login ThaiD สำเร็จ`, 'green');
  return 6;
}
async function stepLK2(req: Request, logId: number, state: number): Promise<number> {
  if (!(state === 6 || state === 7)) return state;

  const logDetailId = await setState(req, logId, 6);
  req.logMessage('SYS', `เริ่มตรวจสอบข้อมูลกับ LK2`, 'purple');
  const ok = await retryUntilDone({
    maxRetry: 5,
    checkCount: () => dataModel.checkDataLKDone(req.db),
    runOnce: () => verifyLK2(req.db, logDetailId),
    delayMs: 60 * 1000,
  });

  if (!ok) {
    await markError(req, 'LK2');
    req.logMessage('ERROR', `เกิดข้อผิดพลาดในการตรวจสอบข้อมูลกับ LK2`, 'red');
    return state;
  }

  await setState(req, logId, 7);
  req.logMessage('SYS', `ตรวจสอบข้อมูลกับ LK2 สำเร็จ`, 'green');
  return 7;
}

async function done(req: Request, logId: number, state: number): Promise<number> {
  if (!(state === 7)) return state;

  await setState(req, logId, 8);
  req.logMessage('SYS', `ประมวลผลสำเร็จ`, 'purple');
  return 8;
}

/** helper: retry ทำซ้ำจน count=0 หรือครบ maxRetry */
async function retryUntilDone(opts: {
  maxRetry: number;
  checkCount: () => Promise<any>;
  runOnce: () => Promise<void>;
  delayMs?: number;
}): Promise<boolean> {
  for (let retry = 0; retry < opts.maxRetry; retry++) {
    const count = await opts.checkCount();
    if ((count?.[0]?.count ?? 0) <= 0) return true;

    if (retry > 0 && opts.delayMs && opts.delayMs > 0) {
      await sleep(opts.delayMs);
    }
    await opts.runOnce();
  }
  // ครบ maxRetry แล้วยังไม่เสร็จ
  return false;
}

/** ตัวอย่าง: เซฟ state ลง DB ให้ชัดเจน */
async function setState(req: Request, logId: number, state: number, count: any = null) {
  // TODO: implement dataModel.updateState(req.db, state)
  await dataModel.updateLogs(req.db, logId, state);
  await dataModel.setState(req.db, logId, state);
  const logdetailid = await dataModel.saveLogDetails(req.db, logId, state, count);
  return logdetailid[0];
}

async function updateLogDetails(req: Request, logDetailId: number, rows: any) {
  await dataModel.updateLogDetails(req.db, logDetailId, { rows: rows });
}
/** ตัวอย่าง: mark error แบบรวมศูนย์ */
async function markError(req: Request, step: string, err?: any) {
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
  onFail: (row: any, error: any) => Promise<void>
) {
  for (const row of rows) {
    try {
      const result = await runner(row);
      await onSuccess(row, result);
    } catch (err) {
      await onFail(row, err);
    }
  }
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
  } = params;

  // await dataModel.setState(db, setStateStart);

  const rows: any[] = getRows ? await getRows(db) : await dataModel.getData(db);

  await processEachRow(
    rows,
    async (row) => {
      const r: any = await retry(() => callDopa(row), {
        maxRetries,
        delayMs: retryDelayMs,
        label,
      });

      if (!r.ok) throw r.error; // ให้ไป onFail
      return r.data;
    },
    async (row, info) => {
      await updateOnSuccess(db, row, info);
    },
    async (row, error) => {
      console.error(`[${label}] failed for row`, row?.id ?? row, error);
      await updateOnFail(db, row, error);
    }
  );

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
    member_code: item.member_code
  }));

  await dataModel.saveData(db, dataSave);
  return dataSave.length
  // await dataModel.setState(db, 2);
}

export async function verifyCheckPOP(db: any, logDetailId: number) {
  return verifyWithDopa({
    db,
    setStateStart: 3,
    setStateDone: 4,
    label: 'CHECKPOP',
    getRows: async (db) => await dataModel.getDataPOPPending(db),
    callDopa: async (row) => await dopaModel.checkpop(row),


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
        // checkpop_error: String(error?.message ?? error),
        // checkpop_updated_at: new Date(),
      });
    },

    maxRetries: 3,
    retryDelayMs: 60 * 1000,
  });
}

export async function verifyLK2(db: any, logDetailId: number) {
  return verifyWithDopa({
    db,
    setStateStart: 5,
    setStateDone: 6,
    label: 'LK2',
    getRows: async (db) => await dataModel.getDataLKPending(db),
    callDopa: async (row) => await dopaModel.checklk2(db, row),

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
      await dataModel.updateData(db, row.id, {
        status_lk: 'FAILED',
        // lk2_error: String(error?.message ?? error),
        // lk2_updated_at: new Date(),
      });
    },

    maxRetries: 3,
    retryDelayMs: 60 * 1000,
  });
}


export default router;