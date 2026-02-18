/// <reference path='../../typings.d.ts' />
import { Router, Request, Response } from 'express';
import * as HttpStatus from 'http-status-codes';
import { DataModel } from '../models/data';
const router: Router = Router();
const dataModel = new DataModel();



router.get('/', async (req: Request, res: Response) => {
  try {
    const rs: any = await dataModel.getUsers(req.db);
    const data = (rs ?? []).map((r: any) => ({
      cid: String(r.cid ?? ''),
      name: String(r.name ?? ''),
    }));
    res.send({ ok: true, data, code: HttpStatus.OK });
  } catch (error: any) {
    const message = error?.message ?? error;
    req.logMessage?.('ERROR', `Users list error: ${message}`, 'red');
    res.send({ ok: false, error: message, code: HttpStatus.INTERNAL_SERVER_ERROR });
  }
});

router.post('/', async (req: Request, res: Response) => {
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
    const message = error?.message ?? error;
    req.logMessage?.('ERROR', `Users create error: ${message}`, 'red');
    res.send({ ok: false, error: message, code: HttpStatus.INTERNAL_SERVER_ERROR });
  }
});

router.put('/', async (req: Request, res: Response) => {
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
    const message = error?.message ?? error;
    req.logMessage?.('ERROR', `Users update error: ${message}`, 'red');
    res.send({ ok: false, error: message, code: HttpStatus.INTERNAL_SERVER_ERROR });
  }
});

router.delete('/:cid', async (req: Request, res: Response) => {
  try {
    const cid = String(req.params.cid ?? '').trim();
    if (!cid) {
      return res.send({ ok: false, error: 'Invalid cid', code: HttpStatus.BAD_REQUEST });
    }
    await dataModel.softDeleteUser(req.db, cid);
    res.send({ ok: true, cid, code: HttpStatus.OK });
  } catch (error: any) {
    const message = error?.message ?? error;
    req.logMessage?.('ERROR', `Users delete error: ${message}`, 'red');
    res.send({ ok: false, error: message, code: HttpStatus.INTERNAL_SERVER_ERROR });
  }
});
export default router;
