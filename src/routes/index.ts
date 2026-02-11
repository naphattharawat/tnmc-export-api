import * as express from 'express';
import { Router, Request, Response } from 'express';
import * as HttpStatus from 'http-status-codes';
import { DataModel } from '../models/data';
import { DataMSSQLModel } from '../models/mssql';
const dataMssqlModel = new DataMSSQLModel();
import { DopaModel } from '../models/dopa';
import * as _ from 'lodash';
import moment = require('moment');
import { token } from 'morgan';
import axios from 'axios';

const dataModel = new DataModel();
const dopaModel = new DopaModel();
const router: Router = Router();

import { Jwt } from '../models/jwt';


const jwt = new Jwt();


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





export default router;
