
import { Router, Request, Response } from 'express';
import * as HttpStatus from 'http-status-codes';
import { DataModel } from '../models/data';
import { LoginModel } from '../models/login';
import { Jwt } from '../models/jwt';
import axios from 'axios';
const dataModel = new DataModel();
const loginModel = new LoginModel();
const router: Router = Router();


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
    // console.log(body);

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
    const check = await loginModel.checkAdmin(req.db, pid);
    if (check.length) {
      return res.send({
        ok: true,
        token: token,
        state: state || undefined,
        code: HttpStatus.OK,
      });
    } else {
      return res.send({
        ok: false,
        error: 'คุณไม่มีสิทธิ์ใช้งานระบบ',
        code: HttpStatus.BAD_REQUEST,
      });
    }
  } catch (error: any) {
    const message = error?.message ?? error;
    req.logMessage?.('ERROR', `ThaiD callback error: ${message}`, 'red');

    return res.send({
      ok: false,
      error: message,
      code: HttpStatus.INTERNAL_SERVER_ERROR,
    });
  }
});





export default router;
