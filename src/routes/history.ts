/// <reference path='../../typings.d.ts' />
import { Router, Request, Response } from 'express';
import * as HttpStatus from 'http-status-codes';
import { HistoryModel } from '../models/history';
const router: Router = Router();
const historyModel = new HistoryModel();


router.get('/', async (req: Request, res: Response) => {
  try {
    const rs = await historyModel.getHistory(req.db);

    res.send({ ok: true, data: rs, code: HttpStatus.OK });
  } catch (error: any) {
    const message = error?.message ?? error;
    req.logMessage?.('ERROR', `History error: ${message}`, 'red');
    res.send({ ok: false, error: error?.message ?? error, code: HttpStatus.INTERNAL_SERVER_ERROR });
  }
});


export default router;
