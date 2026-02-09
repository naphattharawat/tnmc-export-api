import * as express from 'express';
import { Router, Request, Response } from 'express';
import * as HttpStatus from 'http-status-codes';
import { DataModel } from '../models/data';
import { DataMSSQLModel } from '../models/mssql';
import { DopaModel } from '../models/dopa';
import * as _ from 'lodash';
import moment = require('moment');
import { token } from 'morgan';
import axios from 'axios';

const dataModel = new DataModel();
const dataMssqlModel = new DataMSSQLModel();
const dopaModel = new DopaModel();
const router: Router = Router();

import { Jwt } from '../models/jwt';


const jwt = new Jwt();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const convertThaiDobToIso = (dob: unknown): string | null => {
  const raw = String(dob ?? '').trim();
  if (!/^\d{8}$/.test(raw)) return null;

  const year = Number(raw.slice(0, 4)) - 543;
  const month = raw.slice(4, 6);
  const day = raw.slice(6, 8);
  return `${year}-${month}-${day}`;
};

router.get('/', (req: Request, res: Response) => {
  res.send({ ok: true, message: 'Welcome to RESTful api server!', code: HttpStatus.OK });
});

router.all('/thaid/callback', async (req: Request, res: Response) => {
  try {
    const code = String((req.query?.code ?? req.body?.code ?? '')).trim();
    const state = String((req.query?.state ?? req.body?.state ?? '')).trim();
    const codeVerifier = String((req.query?.code_verifier ?? req.body?.code_verifier ?? process.env.THAID_CODE_VERIFIER ?? '')).trim();
    const pidInput = String((req.query?.pid ?? req.query?.personalID ?? req.body?.pid ?? req.body?.personalID ?? '')).trim();

    if (!code) {
      return res.send({ ok: false, error: 'Missing code', code: HttpStatus.BAD_REQUEST });
    }

    const tokenUrl = String(process.env.THAID_TOKEN_URL ?? 'https://imauth.bora.dopa.go.th/api/v2/oauth2/token/').trim();
    const clientId = String(process.env.THAID_CLIENT_ID ?? '').trim();
    const clientSecret = String(process.env.THAID_CLIENT_SECRET ?? '').trim();
    const redirectUri = String(process.env.THAID_REDIRECT_URI ?? '').trim();

    if (!tokenUrl || !clientId || !clientSecret) {
      return res.send({
        ok: false,
        error: 'Missing THAID_* env configuration',
        code: HttpStatus.INTERNAL_SERVER_ERROR,
      });
    }

    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    if (redirectUri) params.append('redirect_uri', redirectUri);
    if (codeVerifier) params.append('code_verifier', codeVerifier);


    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    const tokenRes = await axios.post(tokenUrl, params.toString(), {
      headers,
      timeout: 15000,
      validateStatus: () => true,
    });

    if (tokenRes.status < 200 || tokenRes.status >= 300) {
      return res.send({
        ok: false,
        error: tokenRes.data ?? 'Token exchange failed',
        status: tokenRes.status,
        state: state || undefined,
        code: HttpStatus.BAD_REQUEST,
      });
    }

    const thaidAccessToken = tokenRes.data?.access_token;
    if (!thaidAccessToken) {
      return res.send({
        ok: false,
        error: 'Missing access token from ThaiD response',
        state: state || undefined,
        code: HttpStatus.BAD_REQUEST,
      });
    }

    const pid = pidInput || String(tokenRes.data?.pid)
    if (!pid) {
      return res.send({
        ok: false,
        error: 'Missing pid',
        state: state || undefined,
        code: HttpStatus.BAD_REQUEST,
      });
    }

    const lkConfirmUrl = String(process.env.LK_LOGIN_CONFIRM_URL ?? 'http://172.16.30.145/api/center/login/confirm').trim();
    const lkOfficeId = Number(process.env.LK_OFFICE_ID ?? 337);

    const body = {
      loginType: 2,
      officeID: lkOfficeId,
      personalID: Number(pid),
      accessToken: thaidAccessToken,
    };
    console.log(body);

    const lkConfirmRes = await axios.post(
      lkConfirmUrl,
      body,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
        validateStatus: () => true,
      }
    );

    if (lkConfirmRes.status < 200 || lkConfirmRes.status >= 300) {
      return res.send({
        ok: false,
        error: lkConfirmRes.data ?? 'LK2 login confirm failed',
        status: lkConfirmRes.status,
        state: state || undefined,
        code: HttpStatus.BAD_REQUEST,
      });
    }

    const lkToken =
      lkConfirmRes.data?.token ??
      lkConfirmRes.data?.accessToken ??
      lkConfirmRes.data?.access_token ??
      lkConfirmRes.data?.data?.token;

    if (!lkToken) {
      return res.send({
        ok: false,
        error: 'Missing LK2 token from login confirm response',
        state: state || undefined,
        code: HttpStatus.BAD_REQUEST,
      });
    }

    await dataModel.upsertTokenLK(req.db, {
      cid: pid,
      token: lkToken,
      status: 'ACTIVE',
    });
    const obj = {
      id: tokenRes.data.pid
    }
    let token = jwt.sign(obj);

    return res.send({
      ok: true,
      token: token,
      state: state || undefined,
      code: HttpStatus.OK,
    });
  } catch (error: any) {
    console.log(error);

    return res.send({
      ok: false,
      error: error?.message ?? error,
      code: HttpStatus.INTERNAL_SERVER_ERROR,
    });
  }
});
router.get('/users', async (req: Request, res: Response) => {
  try {
    const rs: any = await dataModel.getUsers(req.db);
    const data = (rs ?? []).map((r: any) => ({
      cid: String(r.cid ?? ''),
      name: String(r.name ?? ''),
    }));
    res.send({ ok: true, data, code: HttpStatus.OK });
  } catch (error: any) {
    res.send({ ok: false, error: error?.message ?? error, code: HttpStatus.INTERNAL_SERVER_ERROR });
  }
});
router.post('/users', async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const items = Array.isArray(body) ? body : Array.isArray(body.items) ? body.items : [body];
    if (!items.length) {
      return res.send({ ok: false, error: 'Empty payload', code: HttpStatus.BAD_REQUEST });
    }

    const saved: Array<{ cid: string; name: string }> = [];
    for (const item of items) {
      const cid = String(item?.cid ?? '').trim();
      const name = String(item?.name ?? '').trim();
      if (!cid) return res.send({ ok: false, error: 'Invalid cid', code: HttpStatus.BAD_REQUEST });
      if (!name) return res.send({ ok: false, error: 'Invalid name', code: HttpStatus.BAD_REQUEST });

      await dataModel.upsertUser(req.db, { cid, name });
      saved.push({ cid, name });
    }

    res.send({ ok: true, data: saved, code: HttpStatus.OK });
  } catch (error: any) {
    res.send({ ok: false, error: error?.message ?? error, code: HttpStatus.INTERNAL_SERVER_ERROR });
  }
});
router.put('/users', async (req: Request, res: Response) => {
  try {
    const cid = String(req.body?.cid ?? '').trim();
    const name = String(req.body?.name ?? '').trim();
    if (!cid) return res.send({ ok: false, error: 'Invalid cid', code: HttpStatus.BAD_REQUEST });
    if (!name) return res.send({ ok: false, error: 'Invalid name', code: HttpStatus.BAD_REQUEST });

    const updated = await dataModel.updateUserName(req.db, cid, name);
    if (!updated) {
      return res.send({ ok: false, error: 'User not found', code: HttpStatus.NOT_FOUND });
    }

    res.send({ ok: true, data: { cid, name }, code: HttpStatus.OK });
  } catch (error: any) {
    res.send({ ok: false, error: error?.message ?? error, code: HttpStatus.INTERNAL_SERVER_ERROR });
  }
});
router.delete('/users/:cid', async (req: Request, res: Response) => {
  try {
    const cid = String(req.params.cid ?? '').trim();
    if (!cid) {
      return res.send({ ok: false, error: 'Invalid cid', code: HttpStatus.BAD_REQUEST });
    }
    await dataModel.softDeleteUser(req.db, cid);
    res.send({ ok: true, cid, code: HttpStatus.OK });
  } catch (error: any) {
    res.send({ ok: false, error: error?.message ?? error, code: HttpStatus.INTERNAL_SERVER_ERROR });
  }
});
router.get('/dates', async (req: Request, res: Response) => {
  try {
    const rs: any = await dataModel.getConfigDatetime(req.db);
    const data = (rs ?? []).map((r: any) => ({
      month: String(r.mm ?? ''),
      day: String(r.dd ?? ''),
      startTime: typeof r.time === 'string' ? r.time.slice(0, 5) : r.time,
      hours: String(r.hour ?? ''),
    }));
    res.send({ ok: true, data, code: HttpStatus.OK });
  } catch (error: any) {
    res.send({ ok: false, error: error?.message ?? error, code: HttpStatus.INTERNAL_SERVER_ERROR });
  }
});
router.post('/dates', async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const items = Array.isArray(body) ? body : Array.isArray(body.items) ? body.items : [body];

    if (!items.length) {
      return res.send({ ok: false, error: 'Empty payload', code: HttpStatus.BAD_REQUEST });
    }

    const rows: Array<{ dd: number; mm: number; time: string; hour: number }> = [];

    for (const item of items) {
      const { month, day, startTime, hours } = item ?? {};

      const mm = Number(month);
      const dd = Number(day);
      const hour = Number(hours);

      if (!Number.isInteger(mm) || mm < 1 || mm > 12) {
        return res.send({ ok: false, error: 'Invalid month', code: HttpStatus.BAD_REQUEST });
      }
      if (!Number.isInteger(dd) || dd < 1 || dd > 31) {
        return res.send({ ok: false, error: 'Invalid day', code: HttpStatus.BAD_REQUEST });
      }
      if (!Number.isInteger(hour) || hour < 0 || hour > 24) {
        return res.send({ ok: false, error: 'Invalid hours', code: HttpStatus.BAD_REQUEST });
      }
      if (typeof startTime !== 'string' || !/^\d{1,2}:\d{2}$/.test(startTime)) {
        return res.send({ ok: false, error: 'Invalid startTime', code: HttpStatus.BAD_REQUEST });
      }

      const [hStr, mStr] = startTime.split(':');
      const h = Number(hStr);
      const m = Number(mStr);
      if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(m) || m < 0 || m > 59) {
        return res.send({ ok: false, error: 'Invalid startTime', code: HttpStatus.BAD_REQUEST });
      }

      const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
      rows.push({ dd, mm, time, hour });
    }

    // ลบทั้งหมด แล้วบันทึกใหม่เสมอ
    await dataModel.saveConfigDatetimeMany(req.db, rows);
    res.send({ ok: true, data: rows, code: HttpStatus.OK });
  } catch (error: any) {
    res.send({ ok: false, error: error?.message ?? error, code: HttpStatus.INTERNAL_SERVER_ERROR });
  }
});
router.get('/process', async (req: Request, res: Response) => {
  try {
    req.logMessage('SYS', 'เริ่มประมวลผลรายงาน', 'purple');
    const current = await getCurrentState(req);
    if (!current) {
      return res.send({ ok: true, state: 'No state found.', code: HttpStatus.OK });
    }
    req.logMessage('SYS', `State ปัจจุบัน = ${current}`, 'purple');
    let state = +current;
    // 1,2
    state = await stepPullData(req, state);
    // 3,4
    state = await stepCheckPop(req, state);
    // 5
    state = await stapWaitLogin(req, state);
    // 6,7
    state = await stepLK2(req, state);

    // 0 finish
    state = await done(req, state);

    return res.send({ ok: true, state: 'Processing done.', code: HttpStatus.OK });
  } catch (error) {
    return res.send({ ok: false, state: 'Processing error.', code: HttpStatus.INTERNAL_SERVER_ERROR });
  }
});

async function getCurrentState(req: Request): Promise<number | null> {
  const rs: any = await dataModel.getState(req.db);
  return rs?.length ? rs[0].state : null;
}

async function stepPullData(req: Request, state: number): Promise<number> {
  if (!(state === 0 || state === 1)) return state;

  try {
    req.logMessage('SYS', `เริ่มดึงข้อมูลจากฐานข้อมูล`, 'purple');
    await setState(req, 1);
    await pullData(req.db, req.dbmssql);
    await setState(req, 2);
    req.logMessage('SYS', `ดึงข้อมูลจากฐานข้อมูลสำเร็จ`, 'green');
    return 2;
  } catch (err) {
    req.logMessage('ERROR', `เกิดข้อผิดพลาดในการดึงข้อมูลจากฐานข้อมูล`, 'red');
    await markError(req, 'PULLDATA', err);
    return state;
  }
}

async function stepCheckPop(req: Request, state: number): Promise<number> {
  if (!(state === 2 || state === 3)) return state;

  await setState(req, 3);
  req.logMessage('SYS', `เริ่มตรวจสอบข้อมูลกับ checkpop`, 'purple');
  const ok = await retryUntilDone({
    maxRetry: 5,
    checkCount: () => dataModel.checkDataPOPDone(req.db),
    runOnce: () => verifyCheckPOP(req.db),
  });

  if (!ok) {
    await markError(req, 'CHECKPOP');
    req.logMessage('ERROR', `เกิดข้อผิดพลาดในการตรวจสอบข้อมูลกับ checkpop`, 'red');
    return state;
  }
  req.logMessage('SYS', `ตรวจสอบข้อมูลกับ checkpop สำเร็จ`, 'green');
  await setState(req, 4);
  return 4;
}

async function stapWaitLogin(req: Request, state: number): Promise<number> {
  if (!(state === 4 || state === 5)) return state;

  // await setState(req, 6);
  req.logMessage('SYS', `เริ่มตรวจสอบการ Login`, 'purple');
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
  await setState(req, 6);
  req.logMessage('SYS', `ตรวจสอบข้อมูลกับ LK2 สำเร็จ`, 'green');
  return 6;
}
async function stepLK2(req: Request, state: number): Promise<number> {
  if (!(state === 6 || state === 7)) return state;

  await setState(req, 6);
  req.logMessage('SYS', `เริ่มตรวจสอบข้อมูลกับ LK2`, 'purple');
  const ok = await retryUntilDone({
    maxRetry: 5,
    checkCount: () => dataModel.checkDataLKDone(req.db),
    runOnce: () => verifyLK2(req.db),
    delayMs: 60 * 1000,
  });

  if (!ok) {
    await markError(req, 'LK2');
    req.logMessage('ERROR', `เกิดข้อผิดพลาดในการตรวจสอบข้อมูลกับ LK2`, 'red');
    return state;
  }

  await setState(req, 7);
  req.logMessage('SYS', `ตรวจสอบข้อมูลกับ LK2 สำเร็จ`, 'green');
  return 7;
}

async function done(req: Request, state: number): Promise<number> {
  if (!(state === 7)) return state;

  await setState(req, 0);
  req.logMessage('SYS', `ประมวลผลสำเร็จ`, 'purple');
  return 0;
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
async function setState(req: Request, state: number) {
  // TODO: implement dataModel.updateState(req.db, state)
  await dataModel.setState(req.db, state);
  await dataModel.saveLogs(req.db, state);
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

  await dataModel.setState(db, setStateStart);

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

  await dataModel.setState(db, setStateDone);
}

// -------------------- functions --------------------
export async function pullData(db: any, dbmssql: any) {
  await dataModel.setState(db, 1);

  const data: any[] = await dataMssqlModel.getData(dbmssql);

  await dataModel.removeData(db);

  const dataSave = _.map(data, (item: any) => ({
    cid: item.cid,
    birth_date: item.birth_date,
  }));

  await dataModel.saveData(db, dataSave);

  await dataModel.setState(db, 2);
}

export async function verifyCheckPOP(db: any) {
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

export async function verifyLK2(db: any) {
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
